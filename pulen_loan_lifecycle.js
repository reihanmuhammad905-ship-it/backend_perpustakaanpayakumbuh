'use strict';

// Endpoint khusus pengguna PULEN Firebase pilot. Auth utama/admin tetap tidak berubah.
// Semua perubahan stok dan pengembalian berada dalam satu transaksi PostgreSQL.
const express = require('express');
const offerNextInTransaction = require('./pulen_queue_notifications').offerNextInTransaction;

module.exports = function createPulenLoanLifecycleRouter({ pool, authenticateToken }) {
  const router = express.Router();

  function requirePulenMember(req, res, next) {
    const userId = Number(req.user && req.user.id);
    if (!Number.isSafeInteger(userId) || userId <= 0 || req.user.scope !== 'pulen-member') {
      return res.status(403).json({status: 'error', message: 'Fitur ini hanya untuk pengguna PULEN yang terautentikasi'});
    }
    req.pulenUserId = userId;
    next();
  }

  router.post('/:loanId/return', authenticateToken, requirePulenMember, async (req, res) => {
    const loanId = Number(req.params.loanId);
    if (!Number.isSafeInteger(loanId) || loanId <= 0) {
      return res.status(400).json({status: 'error', message: 'ID peminjaman tidak valid'});
    }
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const changed = await client.query(`
        UPDATE public.loans
        SET status = 'dikembalikan', tanggal_dikembalikan = CURRENT_TIMESTAMP
        WHERE id = $1 AND user_id = $2 AND status = 'aktif'
        RETURNING id, book_id, status, tanggal_dikembalikan
      `, [loanId, req.pulenUserId]);
      if (changed.rows.length === 0) {
        const existing = await client.query(
          'SELECT status FROM public.loans WHERE id = $1 AND user_id = $2',
          [loanId, req.pulenUserId]
        );
        await client.query('ROLLBACK');
        return res.status(existing.rows.length ? 409 : 404).json({
          status: 'error',
          message: existing.rows.length
            ? 'Peminjaman ini sudah tidak aktif atau sudah dikembalikan'
            : 'Peminjaman tidak ditemukan pada akun Anda',
        });
      }
      const loan = changed.rows[0];
      const stock = await client.query(
        'UPDATE public.books SET stok = COALESCE(stok, 0) + 1 WHERE id = $1 RETURNING id',
        [loan.book_id]
      );
      if (!stock.rows.length) throw new Error('BOOK_NOT_FOUND');
      // Offer the available book to the next waiting person within the same transaction.
      if (process.env.PULEN_AUTO_QUEUE_ENABLED === 'true') {
        await offerNextInTransaction(client, loan.book_id);
      }
      await client.query('COMMIT');
      return res.json({
        status: 'success',
        message: 'Buku berhasil dikembalikan. Akses baca PDF untuk pinjaman ini telah berakhir.',
        loan: {id: loan.id, status: loan.status, tanggal_dikembalikan: loan.tanggal_dikembalikan},
      });
    } catch (err) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch (_) {}
      }
      console.error('[PULEN RETURN] gagal:', err && err.code ? err.code : 'internal_error');
      if (!res.headersSent) {
        return res.status(500).json({status: 'error', message: 'Buku belum dapat dikembalikan. Silakan coba lagi.'});
      }
    } finally {
      if (client) client.release();
    }
  });

  // Berisi buku yang PDF-nya benar-benar pernah berhasil dilayani ke pengguna.
  // Tidak menyamakan "dipinjam" dengan "pernah dibaca".
  router.get('/read-history', authenticateToken, requirePulenMember, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT h.book_id, b.judul, b.penulis, b.cover_url,
               h.first_opened_at, h.last_opened_at, h.open_count
        FROM public.pulen_reading_history h
        JOIN public.books b ON b.id = h.book_id
        WHERE h.user_id = $1
        ORDER BY h.last_opened_at DESC, h.book_id DESC
        LIMIT 200
      `, [req.pulenUserId]);
      return res.json({status: 'success', history: result.rows});
    } catch (err) {
      console.error('[PULEN HISTORY] gagal:', err && err.code ? err.code : 'internal_error');
      return res.status(500).json({status: 'error', message: 'Riwayat baca belum dapat dimuat.'});
    }
  });

  return router;
};
