'use strict';
// Pilot PULEN only. Offers are opportunities (not automatic loans).
// All state transitions are protected by PostgreSQL row locks and occur in DB transactions.
const express = require('express');

function validId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function addNotice(db, {userId, type, title, message, bookId=null, queueId=null, offerId=null}) {
  await db.query(`INSERT INTO public.notifications
    (user_id,type,title,message,book_id,queue_id,offer_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT DO NOTHING`, [userId, type, title, message, bookId, queueId, offerId]);
}

// All callers lock books before touching offers. Only ONE active opportunity/book for pilot.
async function offerNextInTransaction(db, bookId) {
  const settings = await db.query('SELECT auto_queue FROM public.settings WHERE id=1');
  if (settings.rows.length && settings.rows[0].auto_queue === false) return [];
  const book = await db.query('SELECT id, judul, stok FROM public.books WHERE id=$1 FOR UPDATE', [bookId]);
  if (!book.rows.length || Number(book.rows[0].stok) <= 0) return [];
  const current = await db.query(`SELECT COUNT(*) AS count FROM public.pulen_queue_offers
    WHERE book_id=$1 AND status='active'`, [bookId]);
  const available = Math.max(0, Number(book.rows[0].stok) - Number(current.rows[0].count));
  const newOffers = [];
  // Reserve no more opportunities than actual copies available.
  for (let attempt = 0; attempt < Math.min(available + 100, 300) && newOffers.length < available; attempt++) {
    const head = await db.query(`SELECT q.id, q.user_id, q.book_id, q.posisi
      FROM public.queue q WHERE q.book_id=$1 AND q.status='menunggu'
      AND NOT EXISTS (SELECT 1 FROM public.pulen_queue_offers o WHERE o.queue_id=q.id)
      ORDER BY q.posisi ASC NULLS LAST, q.created_at ASC, q.id ASC
      LIMIT 1 FOR UPDATE`, [bookId]);
    if (!head.rows.length) break;
    const q = head.rows[0];
    const already = await db.query(`SELECT 1 FROM public.loans
      WHERE user_id=$1 AND book_id=$2 AND status='aktif' LIMIT 1`, [q.user_id, bookId]);
    if (already.rows.length) {
      await closeQueueInTransaction(db, q, 'selesai');
      continue;
    }
    const created = await db.query(`INSERT INTO public.pulen_queue_offers
      (queue_id,book_id,user_id,expires_at)
      VALUES ($1,$2,$3,NOW()+INTERVAL '24 hours')
      ON CONFLICT DO NOTHING RETURNING id,expires_at`, [q.id, bookId, q.user_id]);
    if (!created.rows.length) break;
    const offer = created.rows[0];
    await addNotice(db, {
      userId:q.user_id, type:'queue_offer', title:'Giliran Meminjam Sudah Tiba',
      message:`Buku "${book.rows[0].judul}" tersedia untuk Anda. Konfirmasi dengan OTP sebelum 24 jam berakhir.`,
      bookId, queueId:q.id, offerId:offer.id,
    });
    newOffers.push(offer);
  }
  return newOffers;
}

async function closeQueueInTransaction(db, q, status) {
  await db.query(`UPDATE public.queue SET status=$2 WHERE id=$1 AND status='menunggu'`, [q.id, status]);
  if (q.posisi !== null && q.posisi !== undefined) {
    await db.query(`UPDATE public.queue SET posisi=posisi-1
      WHERE book_id=$1 AND status='menunggu' AND posisi>$2`, [q.book_id, q.posisi]);
  }
}

async function expireForBookInTransaction(db, bookId) {
  const old = await db.query(`SELECT id,queue_id,user_id FROM public.pulen_queue_offers
    WHERE book_id=$1 AND status='active' AND expires_at<=NOW() FOR UPDATE`, [bookId]);
  for (const offer of old.rows) {
    const q = await db.query('SELECT id,book_id,posisi,status FROM public.queue WHERE id=$1 FOR UPDATE', [offer.queue_id]);
    await db.query(`UPDATE public.pulen_queue_offers
      SET status='expired',completed_at=NOW() WHERE id=$1 AND status='active'`, [offer.id]);
    if (q.rows.length && q.rows[0].status === 'menunggu') {
      await closeQueueInTransaction(db, q.rows[0], 'terlewat');
    }
    await addNotice(db, {userId:offer.user_id, type:'queue_expired',
      title:'Kesempatan Meminjam Berakhir',
      message:'Batas waktu konfirmasi telah habis. Giliran diberikan kepada antrian berikutnya.',
      bookId});
  }
  return old.rows.length;
}

async function maintainBook(pool, bookId) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const lock = await db.query('SELECT id FROM public.books WHERE id=$1 FOR UPDATE', [bookId]);
    if (!lock.rows.length) {await db.query('COMMIT'); return;}
    await expireForBookInTransaction(db, bookId);
    await offerNextInTransaction(db, bookId);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK').catch(()=>{});
    throw error;
  } finally { db.release(); }
}

async function assertQueuePrivilege(db, bookId, userId) {
  const book = await db.query('SELECT stok FROM public.books WHERE id=$1', [bookId]);
  const offers = await db.query(`SELECT id,user_id,expires_at FROM public.pulen_queue_offers
    WHERE book_id=$1 AND status='active' AND expires_at>NOW()`, [bookId]);
  const own = offers.rows.find(r=>Number(r.user_id)===userId);
  if (own) return own;
  const waiting = await db.query(`SELECT 1 FROM public.queue q
    WHERE q.book_id=$1 AND q.status='menunggu'
    AND NOT EXISTS (SELECT 1 FROM public.pulen_queue_offers o WHERE o.queue_id=q.id AND o.status='active')
    LIMIT 1`, [bookId]);
  // First protect every waiting member, then allow unused copies to circulate.
  if (waiting.rows.length || (book.rows.length && offers.rows.length >= Number(book.rows[0].stok))) {
    const error = new Error('Buku sedang diprioritaskan bagi antrian. Tunggu notifikasi giliran Anda.');
    error.statusCode = 409; throw error;
  }
  return null;
}

module.exports = function createPulenQueueNotifications({pool, authenticateToken}) {
  const router = express.Router();
  const confirmOtpRouter = express.Router();
  const queueMutationsRouter = express.Router();

  function member(req,res,next) {
    const userId = validId(req.user && req.user.id);
    if (!userId || req.user.scope !== 'pulen-member') {
      return res.status(403).json({status:'error',message:'Login Google MyKopay yang terhubung ke PULEN diperlukan.'});
    }
    req.pulenUserId = userId;
    next();
  }

  // Scoped inbox: private to the authenticated PULEN local user.
  router.get('/notifications', authenticateToken, member, async (req,res) => {
    try {
      const rows = await pool.query(`SELECT n.id,n.type,n.title,n.message,n.book_id,n.queue_id,
        n.offer_id,n.is_read,n.created_at,b.judul AS book_title,
        o.status AS offer_status,o.expires_at
        FROM public.notifications n
        LEFT JOIN public.books b ON b.id=n.book_id
        LEFT JOIN public.pulen_queue_offers o ON o.id=n.offer_id
        WHERE n.user_id=$1 AND n.deleted_at IS NULL
        ORDER BY n.created_at DESC,n.id DESC LIMIT 100`, [req.pulenUserId]);
      res.json({status:'success', notifications:rows.rows,
        unread_count:rows.rows.filter(r=>!r.is_read).length});
    } catch(error) {console.error('[PULEN NOTIF] get',error.code||'error');
      res.status(500).json({status:'error',message:'Notifikasi belum dapat dimuat.'});}
  });
  router.patch('/notifications/:id/read', authenticateToken, member, async (req,res) => {
    const id = validId(req.params.id);
    if (!id) return res.status(400).json({status:'error',message:'ID notifikasi tidak valid'});
    try {
      const row = await pool.query(`UPDATE public.notifications SET is_read=true
        WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL RETURNING id`, [id,req.pulenUserId]);
      return res.status(row.rows.length?200:404).json({status:row.rows.length?'success':'error',message:row.rows.length?'Notifikasi dibaca':'Notifikasi tidak ditemukan'});
    } catch(error) {res.status(500).json({status:'error',message:'Gagal menandai notifikasi'});}
  });
  router.patch('/notifications/read-all', authenticateToken, member, async (req,res) => {
    try {await pool.query(`UPDATE public.notifications SET is_read=true
        WHERE user_id=$1 AND deleted_at IS NULL AND is_read=false`, [req.pulenUserId]);
      res.json({status:'success'});
    } catch(error) {res.status(500).json({status:'error',message:'Gagal memperbarui notifikasi'});}
  });
  router.delete('/notifications/:id', authenticateToken, member, async (req,res) => {
    const id = validId(req.params.id);
    if (!id) return res.status(400).json({status:'error',message:'ID notifikasi tidak valid'});
    try {const row=await pool.query(`UPDATE public.notifications SET deleted_at=NOW()
       WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL RETURNING id`,[id,req.pulenUserId]);
      res.status(row.rows.length?200:404).json({status:row.rows.length?'success':'error',message:row.rows.length?'Notifikasi dihapus':'Notifikasi tidak ditemukan'});
    } catch(error) {res.status(500).json({status:'error',message:'Gagal menghapus notifikasi'});}
  });
  router.get('/queue/offers/me', authenticateToken, member, async(req,res) => {
    try {const row=await pool.query(`SELECT o.id,o.queue_id,o.book_id,o.status,o.expires_at,b.judul
      FROM public.pulen_queue_offers o JOIN public.books b ON b.id=o.book_id
      WHERE o.user_id=$1 AND o.status='active' AND o.expires_at>NOW()
      ORDER BY o.expires_at ASC`,[req.pulenUserId]);
      res.json({status:'success',offers:row.rows});
    } catch(error) {res.status(500).json({status:'error',message:'Status kesempatan meminjam gagal dimuat'});}
  });
  router.get('/queue/history', authenticateToken, member, async(req,res) => {
    try {const row=await pool.query(`SELECT q.id,q.book_id,q.status,q.created_at,b.judul,
       o.offered_at,o.expires_at,o.completed_at,o.status AS offer_status
       FROM public.queue q JOIN public.books b ON b.id=q.book_id
       LEFT JOIN public.pulen_queue_offers o ON o.queue_id=q.id
       WHERE q.user_id=$1 AND q.status<>'menunggu'
       ORDER BY q.created_at DESC,q.id DESC LIMIT 100`,[req.pulenUserId]);
      res.json({status:'success',history:row.rows});
    } catch(error) {res.status(500).json({status:'error',message:'Riwayat antrian belum dapat dimuat'});}
  });

  // Pilot join/cancel preserve queue history and avoid position races.
  queueMutationsRouter.post('/', authenticateToken, async (req,res,next) => {
    if (process.env.PULEN_AUTO_QUEUE_ENABLED !== 'true' || req.user.scope !== 'pulen-member') return next();
    const userId=validId(req.user.id), bookId=validId(req.body && req.body.book_id);
    if (!userId || !bookId) return res.status(400).json({status:'error',message:'ID buku tidak valid'});
    let db;
    try {
      db=await pool.connect(); await db.query('BEGIN');
      const book=await db.query('SELECT id,judul FROM public.books WHERE id=$1 FOR UPDATE',[bookId]);
      if(!book.rows.length) {await db.query('ROLLBACK');return res.status(404).json({status:'error',message:'Buku tidak ditemukan'});}
      const setting=await db.query('SELECT auto_queue FROM public.settings WHERE id=1');
      if(setting.rows.length && setting.rows[0].auto_queue===false) {
        await db.query('ROLLBACK');return res.status(409).json({status:'error',message:'Antrian dinonaktifkan oleh admin'});
      }
      const pending=await db.query(`SELECT id FROM public.queue
        WHERE user_id=$1 AND book_id=$2 AND status='menunggu'`,[userId,bookId]);
      if(pending.rows.length) {await db.query('ROLLBACK');return res.status(409).json({status:'error',message:'Anda sudah dalam antrian buku ini'});}
      const held=await db.query(`SELECT id FROM public.loans
        WHERE user_id=$1 AND book_id=$2 AND status='aktif' LIMIT 1`,[userId,bookId]);
      if(held.rows.length) {await db.query('ROLLBACK');return res.status(409).json({status:'error',message:'Anda sudah meminjam buku ini'});}
      const count=await db.query(`SELECT COALESCE(MAX(posisi),0) AS n FROM public.queue WHERE book_id=$1 AND status='menunggu'`,[bookId]);
      const position=Number(count.rows[0].n)+1;
      const inserted=await db.query(`INSERT INTO public.queue
        (user_id,book_id,status,posisi) VALUES ($1,$2,'menunggu',$3) RETURNING id,posisi`,[userId,bookId,position]);
      await addNotice(db,{userId,type:'queue',title:'Masuk Antrian',
        message:`Anda masuk antrian "${book.rows[0].judul}" di posisi #${position}.`,bookId,queueId:inserted.rows[0].id});
      await offerNextInTransaction(db,bookId);
      await db.query('COMMIT');
      return res.json({status:'success',queue:inserted.rows[0]});
    } catch(error) {
      if(db) await db.query('ROLLBACK').catch(()=>{});
      console.error('[PULEN QUEUE JOIN]',error.code||'error');
      return res.status(500).json({status:'error',message:'Belum dapat masuk antrian'});
    } finally {if(db) db.release();}
  });

  queueMutationsRouter.delete('/:id', authenticateToken, async (req,res,next) => {
    if (process.env.PULEN_AUTO_QUEUE_ENABLED !== 'true' || req.user.scope !== 'pulen-member') return next();
    const userId=validId(req.user.id), queueId=validId(req.params.id);
    if(!userId || !queueId) return res.status(400).json({status:'error',message:'ID antrian tidak valid'});
    let db;
    try {
      db=await pool.connect(); await db.query('BEGIN');
      const locate=await db.query('SELECT book_id FROM public.queue WHERE id=$1 AND user_id=$2',[queueId,userId]);
      if(!locate.rows.length) {await db.query('ROLLBACK');return res.status(404).json({status:'error',message:'Antrian tidak ditemukan'});}
      const bookId=Number(locate.rows[0].book_id);
      await db.query('SELECT id FROM public.books WHERE id=$1 FOR UPDATE',[bookId]);
      const q=await db.query('SELECT id,book_id,posisi,status FROM public.queue WHERE id=$1 AND user_id=$2 FOR UPDATE',[queueId,userId]);
      if(!q.rows.length || q.rows[0].status!=='menunggu') {
        await db.query('ROLLBACK');return res.status(409).json({status:'error',message:'Antrian sudah selesai atau tidak aktif'});
      }
      await db.query(`UPDATE public.pulen_queue_offers SET status='cancelled',completed_at=NOW()
        WHERE queue_id=$1 AND status='active'`,[queueId]);
      await closeQueueInTransaction(db,q.rows[0],'dibatalkan');
      await addNotice(db,{userId,type:'queue_cancelled',title:'Antrian Dibatalkan',
        message:'Antrian buku Anda telah dibatalkan.',bookId,queueId});
      await offerNextInTransaction(db,bookId);
      await db.query('COMMIT');return res.json({status:'success'});
    } catch(error) {
      if(db) await db.query('ROLLBACK').catch(()=>{});
      console.error('[PULEN QUEUE CANCEL]',error.code||'error');
      return res.status(500).json({status:'error',message:'Belum dapat membatalkan antrian'});
    } finally {if(db) db.release();}
  });

  // Intercept pilot OTP confirmation: atomic stock, OTP and queue-claim, no double borrow.
  // Other existing accounts continue into existing route; do not change admin authentication.
  confirmOtpRouter.post('/', authenticateToken, async(req,res,next) => {
    if (process.env.PULEN_AUTO_QUEUE_ENABLED !== 'true' || req.user.scope !== 'pulen-member') return next();
    const userId=validId(req.user.id);
    const bookId=validId(req.body && req.body.book_id);
    const code=String(req.body && req.body.code || '');
    if (!userId || !bookId || !/^\d{6}$/.test(code)) {
      return res.status(400).json({status:'error',message:'Data peminjaman atau kode OTP tidak valid'});
    }
    let db;
    try {
      await maintainBook(pool,bookId); // Expire overdue opportunity if necessary.
      db=await pool.connect(); await db.query('BEGIN');
      const book=await db.query('SELECT * FROM public.books WHERE id=$1 FOR UPDATE',[bookId]);
      if(!book.rows.length) {await db.query('ROLLBACK');return res.status(404).json({status:'error',message:'Buku tidak ditemukan'});}
      if(Number(book.rows[0].stok)<=0) {await db.query('ROLLBACK');return res.status(409).json({status:'error',message:'Buku sedang tidak tersedia'});}
      const offer=await assertQueuePrivilege(db,bookId,userId);
      const otp=await db.query(`SELECT id FROM public.loan_otps WHERE user_id=$1 AND book_id=$2
          AND code=$3 AND used=false AND expires_at>NOW()
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[userId,bookId,code]);
      if(!otp.rows.length) {await db.query('ROLLBACK');return res.status(400).json({status:'error',message:'OTP salah, sudah dipakai, atau kedaluwarsa'});}
      const settings=await db.query('SELECT loan_duration_days,max_books_per_member FROM public.settings WHERE id=1');
      const max=Number(settings.rows[0]?.max_books_per_member||3), days=Number(settings.rows[0]?.loan_duration_days||7);
      const active=await db.query(`SELECT book_id FROM public.loans WHERE user_id=$1 AND status='aktif' FOR UPDATE`,[userId]);
      if(active.rows.some(r=>Number(r.book_id)===bookId)) {await db.query('ROLLBACK');return res.status(409).json({status:'error',message:'Buku ini sudah Anda pinjam'});}
      if(active.rows.length>=max) {await db.query('ROLLBACK');return res.status(409).json({status:'error',message:'Batas maksimal buku dipinjam telah tercapai'});}
      const borrowed=await db.query(`INSERT INTO public.loans
        (user_id,book_id,status,tanggal_pinjam,tanggal_kembali)
        VALUES ($1,$2,'aktif',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP + ($3 * INTERVAL '1 day'))
        RETURNING id,tanggal_pinjam,tanggal_kembali`,[userId,bookId,days]);
      await db.query(`UPDATE public.books SET stok=stok-1 WHERE id=$1 AND stok>0`,[bookId]);
      await db.query('UPDATE public.loan_otps SET used=true WHERE id=$1',[otp.rows[0].id]);
      if(offer) {
        await db.query(`UPDATE public.pulen_queue_offers SET status='claimed',completed_at=NOW()
          WHERE id=$1 AND status='active'`,[offer.id]);
        const queue=await db.query(`SELECT id,book_id,posisi,status FROM public.queue
          WHERE id=(SELECT queue_id FROM public.pulen_queue_offers WHERE id=$1) FOR UPDATE`,[offer.id]);
        if(queue.rows.length && queue.rows[0].status==='menunggu') await closeQueueInTransaction(db,queue.rows[0],'selesai');
      }
      await addNotice(db,{userId,type:'borrow',title:'Peminjaman Berhasil',
        message:`Anda berhasil meminjam "${book.rows[0].judul}" selama ${days} hari.`,bookId});
      await offerNextInTransaction(db,bookId); // If stock remains, serve the next waiting member.
      await db.query('COMMIT');
      return res.json({status:'success',loan:{...borrowed.rows[0],book:book.rows[0]},
        message:'Peminjaman berhasil'});
    } catch(error) {
      if(db) await db.query('ROLLBACK').catch(()=>{});
      console.error('[PULEN OTP QUEUE]',error.code||'error');
      return res.status(error.statusCode||500).json({status:'error',message:error.statusCode?error.message:'Peminjaman belum dapat dikonfirmasi'});
    } finally {if(db) db.release();}
  });

  // Enforce queue priority before old direct/OTP-request routes, for all PULEN identities.
  function guardBorrow(req,res,next) {
    if(process.env.PULEN_AUTO_QUEUE_ENABLED !== 'true' || req.method!=='POST' || !['/api/loans','/api/loans/request-otp'].includes(req.path)) return next();
    return authenticateToken(req,res,async()=>{
      const bookId=validId(req.body && req.body.book_id), userId=validId(req.user && req.user.id);
      if(!bookId || !userId) return next(); // Existing endpoint handles validation.
      try {
        await maintainBook(pool,bookId);
        await assertQueuePrivilege(pool,bookId,userId);
        if(req.path==='/api/loans' && req.user.scope==='pulen-member') {
          return res.status(409).json({status:'error',message:'Peminjaman PULEN harus melalui verifikasi OTP.'});
        }
        return next();
      } catch(error) {console.error('[PULEN QUEUE GUARD]',error.code||'error');
        return res.status(503).json({status:'error',message:'Pengecekan giliran belum tersedia. Silakan coba kembali.'});}
    });
  }

  // Reconcile invitations after restart and expiry. Never silently loan books.
  let working=false;
  async function runWorker() {
    if(working) return;
    working=true;
    try {
      const ids=await pool.query(`SELECT DISTINCT book_id FROM public.queue
        WHERE status='menunggu' UNION SELECT book_id FROM public.pulen_queue_offers WHERE status='active'`);
      for(const r of ids.rows.slice(0,300)) await maintainBook(pool,Number(r.book_id));
    } catch(error) {console.error('[PULEN QUEUE WORKER]',error.code||'error');}
    finally {working=false;}
  }
  function startWorker() {
    if(process.env.PULEN_AUTO_QUEUE_ENABLED!=='true') {
      console.log('[PULEN QUEUE] automation disabled (pilot flag)'); return;
    }
    setTimeout(runWorker,2500).unref();
    setInterval(runWorker,60*1000).unref();
  }
  return {router,confirmOtpRouter,queueMutationsRouter,guardBorrow,startWorker};
};
module.exports.offerNextInTransaction=offerNextInTransaction;
