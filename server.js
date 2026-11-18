require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
// Batasi file PDF: sampul tetap publik, PDF hanya lewat /api/loans/:id/read-pdf.
app.use('/uploads', (req, res, next) => {
  let requestedPath;
  try { requestedPath = decodeURIComponent(req.path); }
  catch (_) { return res.status(400).json({status:'error',message:'URL file tidak valid'}); }
  if (require('path').extname(requestedPath).toLowerCase() === '.pdf') {
    return res.status(403).json({status:'error',message:'PDF hanya dapat dibaca melalui pinjaman aktif'});
  }
  next();
});
app.use('/uploads', express.static('uploads'));

const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
});

const nodemailer = require('nodemailer');

const emailTransporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

function generateOtpCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}


async function generateMemberId(db = pool) {
  const year = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Jakarta',
      year: 'numeric',
    }).format(new Date())
  );

  const result = await db.query(
    `
    INSERT INTO public.pulen_member_number_counters
      (year, last_number)
    VALUES ($1, 1)
    ON CONFLICT (year)
    DO UPDATE SET last_number =
      public.pulen_member_number_counters.last_number + 1
    RETURNING last_number
    `,
    [year]
  );

  const number = result.rows[0].last_number;

  return `PMB-${year}${String(number).padStart(4, '0')}`;
}


async function createNotification(userId, type, title, message) {
  try {
    await pool.query(
      'INSERT INTO notifications (user_id, type, title, message) VALUES ($1, $2, $3, $4)',
      [userId, type, title, message]
    );
  } catch (err) {
    console.log('Gagal membuat notifikasi:', err.message);
  }
}

app.get('/', (req, res) => {
  res.json({ message: 'Backend Perpustakaan Payakumbuh aktif!' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.get('/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ status: 'success', time: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET SEMUA BUKU
app.get('/api/books', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        b.id, b.judul, b.penulis, b.deskripsi, b.stok, b.file_url,
        b.penerbit, b.tahun_terbit, b.jumlah_halaman, b.bahasa, b.format_file, b.cover_url,
        c.nama AS kategori,
        (SELECT COUNT(*) FROM loans l WHERE l.book_id = b.id AND l.status = 'aktif') AS dipinjam,
        (SELECT COUNT(*) FROM queue q WHERE q.book_id = b.id AND q.status = 'menunggu') AS antrian
      FROM books b
      LEFT JOIN categories c ON b.category_id = c.id
      ORDER BY b.created_at DESC
    `);
    res.json({ status: 'success', books: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// BUKU REKOMENDASI (berdasarkan tren peminjaman)
app.get('/api/books/recommended', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        b.id, b.judul, b.penulis, b.deskripsi, b.stok, b.file_url,
        b.penerbit, b.tahun_terbit, b.jumlah_halaman, b.bahasa, b.format_file, b.cover_url,
        c.nama AS kategori,
        (SELECT COUNT(*) FROM loans l WHERE l.book_id = b.id AND l.status = 'aktif') AS dipinjam,
        (SELECT COUNT(*) FROM queue q WHERE q.book_id = b.id AND q.status = 'menunggu') AS antrian,
        (SELECT COUNT(*) FROM loans l2 WHERE l2.book_id = b.id) AS total_peminjaman
      FROM books b
      LEFT JOIN categories c ON b.category_id = c.id
      ORDER BY total_peminjaman DESC, b.created_at DESC
      LIMIT 8
    `);
    res.json({ status: 'success', books: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET SEMUA KATEGORI (untuk app, publik)
app.get('/api/categories', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, nama AS name FROM categories ORDER BY nama ASC');
    res.json({ status: 'success', categories: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const createMyKopayRouter = require('./pulen_mykopay_auth');

app.use('/api/auth', createMyKopayRouter({
  pool,
  jwt,
  bcrypt,
  generateMemberId,
}));





// Cek token login (dipakai untuk endpoint yang perlu tahu siapa yang login)
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ status: 'error', message: 'Anda harus login terlebih dahulu' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ status: 'error', message: 'Sesi login tidak valid, silakan login ulang' });
    }
    req.user = user;
    next();
  });
}


// PULEN Firebase pilot: hanya aktif jika PULEN_FIREBASE_PILOT_ENABLED=true.
const createPulenFirebaseRouter = require('./pulen_firebase_auth');
app.use('/api/auth/firebase', createPulenFirebaseRouter({ pool, jwt }));

// PDF hanya dari ID pinjaman dan JWT PULEN; bukan URL file publik.
const createPulenProtectedPdfRouter = require('./pulen_protected_pdf');
app.use('/api/loans', createPulenProtectedPdfRouter({ pool, authenticateToken }));
// Pengembalian oleh anggota PULEN dan API riwayat baca (isolasi dari login/admin).
const createPulenLoanLifecycleRouter = require('./pulen_loan_lifecycle');
app.use('/api/loans', createPulenLoanLifecycleRouter({ pool, authenticateToken }));
const createPulenMemberProfileRouter = require('./pulen_member_profile');
app.use('/api/pulen/profile', createPulenMemberProfileRouter({ pool, authenticateToken }));

// Proses otomatis: pinjaman yang lewat jatuh tempo & belum dikembalikan
// jadi 'berakhir_otomatis', stoknya dikembalikan satu.
// PULEN stock transition safety V1 (admin, legacy member, expired loans)
const { closeLoan: closePulenLoanSafely } = require('./pulen_stock_transitions');

// Expire one loan at a time through the same atomic transition used by admin.
// If a return wins the race, the expired transition is a no-op and stock is not duplicated.
async function processExpiredLoans() {
  try {
    const expired = await pool.query(`SELECT id FROM public.loans
      WHERE status='aktif' AND tanggal_kembali < NOW()
      ORDER BY tanggal_kembali ASC, id ASC LIMIT 100`);
    for (const row of expired.rows) {
      try {
        const result = await closePulenLoanSafely({
          pool, loanId: row.id, newStatus: 'berakhir_otomatis', requireExpired: true
        });
        if (!result.changed) continue;
        try {
          await createNotification(
            result.loan.user_id, 'overdue', 'Peminjaman Berakhir Otomatis',
            'Peminjaman Anda telah melewati batas waktu dan berakhir otomatis.'
          );
        } catch (noticeError) {
          console.error('[PULEN AUTO-EXPIRE] notification', noticeError.code || 'error');
        }
      } catch (loanError) {
        console.error('[PULEN AUTO-EXPIRE] loan', row.id, loanError.code || 'error');
      }
    }
  } catch (error) {
    console.error('[PULEN AUTO-EXPIRE] list', error.code || 'error');
  }
}

const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Konfigurasi upload foto profil
const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `profile_${req.user.id}_${Date.now()}${ext}`);
  },
});

const uploadPhoto = multer({
  storage: photoStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // maksimal 2MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Format file harus JPG, PNG, atau WEBP'));
    }
  },
});

// Konfigurasi upload cover buku
const coverStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `book_${req.params.id}_${Date.now()}${ext}`);
  },
});

const uploadCover = multer({
  storage: coverStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Format file harus JPG, PNG, atau WEBP'));
    }
  },
});

// Konfigurasi upload file PDF buku
const pdfStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.pdf';
    cb(null, `bookfile_${req.params.id}_${Date.now()}${ext}`);
  },
});

const uploadBookPdf = multer({
  storage: pdfStorage,
  limits: { fileSize: 20 * 1024 * 1024 }, // maksimal 20MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('File harus berformat PDF'));
    }
  },
});

// REGISTER
app.post('/api/register', async (req, res) => {
  const { nama, email, password } = req.body;

  if (!nama || !email || !password) {
    return res.status(400).json({ status: 'error', message: 'Semua field wajib diisi' });
  }

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ status: 'error', message: 'Email sudah terdaftar' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const memberId = await generateMemberId();

    const result = await pool.query(
      'INSERT INTO users (nama, email, password, email_verified, member_id) VALUES ($1, $2, $3, false, $4) RETURNING id, nama, email',
      [nama, email, password_hash, memberId]
    );
    const newUser = result.rows[0];

    const code = generateOtpCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query(
      'INSERT INTO email_verifications (user_id, code, expires_at) VALUES ($1, $2, $3)',
      [newUser.id, code, expiresAt]
    );

    await emailTransporter.sendMail({
      from: `"Perpustakaan Kota Payakumbuh" <${process.env.EMAIL_USER}>`,
      to: newUser.email,
      subject: 'Verifikasi Email Pendaftaran',
      html: `
        <p>Halo ${newUser.nama},</p>
        <p>Terima kasih telah mendaftar. Kode verifikasi email Anda:</p>
        <h2 style="letter-spacing: 4px;">${code}</h2>
        <p>Kode ini berlaku selama 10 menit.</p>
      `,
    });

    res.json({ status: 'success', user: newUser, message: 'Kode verifikasi telah dikirim ke email Anda' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// LOGIN
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(400).json({ status: 'error', message: 'Email atau password salah' });
    }

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);

    if (!match) {
      return res.status(400).json({ status: 'error', message: 'Email atau password salah' });
    }

    if (user.member_status === 'Diblokir') {
      return res.status(403).json({ status: 'error', message: 'Akun Anda diblokir. Silakan hubungi admin perpustakaan.' });
    }

    if (!user.email_verified) {
      return res.status(403).json({ status: 'error', message: 'Email belum diverifikasi. Silakan cek email Anda.' });
    }

    const role = user.is_admin ? 'admin' : 'anggota';

    const token = jwt.sign(
      { id: user.id, email: user.email, role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      status: 'success',
      token,
      user: { id: user.id, nama: user.nama, email: user.email, role },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Cek bahwa yang login adalah admin (dipakai untuk endpoint kelola buku/anggota nanti)
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ status: 'error', message: 'Akses ditolak, khusus admin' });
  }
  next();
}

// ADMIN REGISTER
app.post('/api/admin/register', authenticateToken, requireAdmin, async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ status: 'error', message: 'Semua field wajib diisi' });
  }
  if (password.length < 8) {
    return res.status(400).json({ status: 'error', message: 'Password minimal 8 karakter' });
  }

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ status: 'error', message: 'Email sudah terdaftar' });
    }

    const password_hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      'INSERT INTO users (nama, email, password, is_admin) VALUES ($1, $2, $3, true) RETURNING id, nama, email',
      [name, email, password_hash]
    );
    const admin = result.rows[0];

    const token = jwt.sign(
      { id: admin.id, email: admin.email, role: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      status: 'success',
      token,
      admin: { id: admin.id, name: admin.nama, email: admin.email, role: 'admin' },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ADMIN LOGIN
app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(400).json({ status: 'error', message: 'Email atau password salah' });
    }

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(400).json({ status: 'error', message: 'Email atau password salah' });
    }

    if (!user.is_admin) {
      return res.status(403).json({ status: 'error', message: 'Akun ini bukan akun admin' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      status: 'success',
      token,
      admin: { id: user.id, name: user.nama, email: user.email, role: 'admin' },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// PINJAM BUKU
// PULEN queue pilot integration (isolated; does not change MyKopay login)
const createPulenQueueNotifications = require('./pulen_queue_notifications');
const pulenQueueNotifications = createPulenQueueNotifications({pool, authenticateToken});
app.use('/api/pulen', pulenQueueNotifications.router);
app.use('/api/loans/confirm-otp', pulenQueueNotifications.confirmOtpRouter);
app.use('/api/queue', pulenQueueNotifications.queueMutationsRouter);
app.use(pulenQueueNotifications.guardBorrow);
pulenQueueNotifications.startWorker();

app.post('/api/loans', authenticateToken, async (req, res) => {
  const { book_id } = req.body;
  const user_id = req.user.id;

  try {
    const settingsResult = await pool.query('SELECT loan_duration_days, max_books_per_member FROM settings WHERE id = 1');
    const settings = settingsResult.rows[0] || { loan_duration_days: 7, max_books_per_member: 3 };

    const activeCountResult = await pool.query("SELECT COUNT(*) FROM loans WHERE user_id = $1 AND status = 'aktif'", [user_id]);
    if (parseInt(activeCountResult.rows[0].count) >= settings.max_books_per_member) {
      return res.status(400).json({ status: 'error', message: `Anda sudah mencapai batas maksimal ${settings.max_books_per_member} buku yang dipinjam` });
    }

    const bookResult = await pool.query(`
      SELECT id, judul, penulis, penerbit, tahun_terbit, isbn, jenis_format,
             deskripsi, stok, jumlah_halaman, cover_url, file_url
      FROM books
      WHERE id = $1
    `, [book_id]);
    if (bookResult.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'Buku tidak ditemukan' });
    }
    if (bookResult.rows[0].stok <= 0) {
      return res.status(400).json({ status: 'error', message: 'Buku sedang tidak tersedia' });
    }

    const existing = await pool.query(
      "SELECT id FROM loans WHERE user_id = $1 AND book_id = $2 AND status = 'aktif'",
      [user_id, book_id]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ status: 'error', message: 'Anda sudah meminjam buku ini' });
    }

    const tanggalKembali = new Date();
    tanggalKembali.setDate(tanggalKembali.getDate() + settings.loan_duration_days);

    const loanResult = await pool.query(
      `INSERT INTO loans (user_id, book_id, status, tanggal_pinjam, tanggal_kembali)
       VALUES ($1, $2, 'aktif', CURRENT_TIMESTAMP, $3)
       RETURNING id, tanggal_pinjam, tanggal_kembali`,
      [user_id, book_id, tanggalKembali]
    );

    await pool.query('UPDATE books SET stok = stok - 1 WHERE id = $1', [book_id]);

    res.json({
      status: 'success',
      loan: {
        ...loanResult.rows[0],
        book: bookResult.rows[0],
      },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// MASUK ANTRIAN
app.post('/api/queue', authenticateToken, async (req, res) => {
  const { book_id } = req.body;
  const user_id = req.user.id;

  try {
    const settingsResult = await pool.query('SELECT auto_queue FROM settings WHERE id = 1');
    if (settingsResult.rows[0] && settingsResult.rows[0].auto_queue === false) {
      return res.status(400).json({ status: 'error', message: 'Sistem antrian sedang dinonaktifkan oleh admin' });
    }

    const existing = await pool.query(
      "SELECT id FROM queue WHERE user_id = $1 AND book_id = $2 AND status = 'menunggu'",
      [user_id, book_id]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ status: 'error', message: 'Anda sudah dalam antrian buku ini' });
    }

    const countResult = await pool.query(
      "SELECT COUNT(*) FROM queue WHERE book_id = $1 AND status = 'menunggu'",
      [book_id]
    );
    const posisi = parseInt(countResult.rows[0].count) + 1;

    const queueResult = await pool.query(
      `INSERT INTO queue (user_id, book_id, status, posisi)
       VALUES ($1, $2, 'menunggu', $3)
       RETURNING id, posisi`,
      [user_id, book_id, posisi]
    );

    await createNotification(
      user_id, 'queue', 'Masuk Antrian',
      `Anda berada di posisi #${posisi} dalam antrian.`
    );

    res.json({ status: 'success', queue: queueResult.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET RIWAYAT PINJAMAN SAYA (yang masih aktif)
app.get('/api/loans/my', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT l.id, l.book_id, l.status, l.tanggal_pinjam, l.tanggal_kembali,
             b.judul, b.penulis, b.penerbit, b.tahun_terbit, b.isbn,
             b.cover_url, b.file_url, b.jumlah_halaman, b.jenis_format,
             b.deskripsi, l.halaman_terakhir
      FROM loans l
      JOIN books b ON l.book_id = b.id
      WHERE l.user_id = $1 AND l.status = 'aktif'
      ORDER BY l.tanggal_pinjam DESC
    `, [req.user.id]);
    res.json({ status: 'success', loans: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// KEMBALIKAN BUKU — kompatibilitas pengguna legacy.
// Firebase PULEN users already use the earlier, scoped lifecycle router.
app.post('/api/loans/:id/return', authenticateToken, async (req, res) => {
  try {
    const result = await closePulenLoanSafely({
      pool, loanId: req.params.id, userId: req.user.id
    });
    if (!result.changed) return res.status(result.reason === 'invalid' ? 400 : 404).json({
      status: 'error', message: 'Peminjaman tidak ditemukan atau tidak aktif'
    });
    return res.json({status:'success', message:'Buku berhasil dikembalikan'});
  } catch (error) {
    console.error('[PULEN LEGACY RETURN]', error.code || 'error');
    return res.status(500).json({status:'error', message:'Pengembalian belum berhasil. Silakan coba lagi.'});
  }
});

// SIMPAN POSISI TERAKHIR BACA
app.put('/api/loans/:id/progress', authenticateToken, async (req, res) => {
  const { halaman } = req.body;
  try {
    const result = await pool.query(
      "UPDATE loans SET halaman_terakhir = $1 WHERE id = $2 AND user_id = $3 AND status = 'aktif' RETURNING id",
      [halaman, req.params.id, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'Data peminjaman tidak ditemukan' });
    }
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET BUKU YANG DISIMPAN
app.get('/api/saved-books/my', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT sb.id AS saved_id, sb.created_at, sb.book_id,
             b.judul, b.penulis, b.cover_url, c.nama AS kategori
      FROM saved_books sb
      JOIN books b ON sb.book_id = b.id
      LEFT JOIN categories c ON b.category_id = c.id
      WHERE sb.user_id = $1
      ORDER BY sb.created_at DESC
    `, [req.user.id]);
    res.json({ status: 'success', saved: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// SIMPAN BUKU
app.post('/api/saved-books', authenticateToken, async (req, res) => {
  const { book_id } = req.body;
  try {
    await pool.query(
      `INSERT INTO saved_books (user_id, book_id) VALUES ($1, $2)
       ON CONFLICT (user_id, book_id) DO NOTHING`,
      [req.user.id, book_id]
    );
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// HAPUS DARI DISIMPAN
app.delete('/api/saved-books/:bookId', authenticateToken, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM saved_books WHERE user_id = $1 AND book_id = $2',
      [req.user.id, req.params.bookId]
    );
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET BUKU FAVORIT
app.get('/api/favorites/my', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT f.id AS favorite_id, f.created_at, f.book_id,
             b.judul, b.penulis, b.stok, b.cover_url,
             c.nama AS kategori,
             (SELECT COUNT(*) FROM loans l WHERE l.book_id = b.id AND l.status = 'aktif') AS dipinjam_count
      FROM favorites f
      JOIN books b ON f.book_id = b.id
      LEFT JOIN categories c ON b.category_id = c.id
      WHERE f.user_id = $1
      ORDER BY f.created_at DESC
    `, [req.user.id]);
    res.json({ status: 'success', favorites: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// TAMBAH KE FAVORIT
app.post('/api/favorites', authenticateToken, async (req, res) => {
  const { book_id } = req.body;
  try {
    await pool.query(
      `INSERT INTO favorites (user_id, book_id) VALUES ($1, $2)
       ON CONFLICT (user_id, book_id) DO NOTHING`,
      [req.user.id, book_id]
    );
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// HAPUS DARI FAVORIT
app.delete('/api/favorites/:bookId', authenticateToken, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM favorites WHERE user_id = $1 AND book_id = $2',
      [req.user.id, req.params.bookId]
    );
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET RIWAYAT BACA (buku yang sudah dikembalikan)
app.get('/api/loans/history', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT l.id, l.book_id, l.tanggal_pinjam, l.tanggal_dikembalikan, l.halaman_terakhir,
             b.judul, b.penulis, b.cover_url, b.jumlah_halaman
      FROM loans l
      JOIN books b ON l.book_id = b.id
      WHERE l.user_id = $1 AND l.status IN ('dikembalikan', 'berakhir_otomatis')
      ORDER BY l.tanggal_dikembalikan DESC
    `, [req.user.id]);
    res.json({ status: 'success', history: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET PROFIL SAYA (+ statistik aktivitas)
app.get('/api/profile', authenticateToken, async (req, res) => {
  try {
    const userResult = await pool.query(
      'SELECT id, nama, email, phone, gender, address, member_id, photo_url, poin_literasi, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'User tidak ditemukan' });
    }

    const dipinjamResult = await pool.query(
      "SELECT COUNT(*) FROM loans WHERE user_id = $1 AND status = 'aktif'",
      [req.user.id]
    );
    const favoritResult = await pool.query('SELECT COUNT(*) FROM favorites WHERE user_id = $1', [req.user.id]);
    const dibacaResult = await pool.query(
      "SELECT COUNT(*) FROM loans WHERE user_id = $1 AND status = 'dikembalikan'",
      [req.user.id]
    );
    const antrianResult = await pool.query(
      "SELECT COUNT(*) FROM queue WHERE user_id = $1 AND status = 'menunggu'",
      [req.user.id]
    );

    res.json({
      status: 'success',
      profile: {
        ...userResult.rows[0],
        buku_dipinjam: parseInt(dipinjamResult.rows[0].count),
        buku_favorit: parseInt(favoritResult.rows[0].count),
        sudah_dibaca: parseInt(dibacaResult.rows[0].count),
        antrian: parseInt(antrianResult.rows[0].count),
      },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// UPDATE PROFIL (nama, email, phone, gender, address)
app.put('/api/profile', authenticateToken, async (req, res) => {
  const { nama, email, phone, gender, address } = req.body;
  try {
    const result = await pool.query(
      `UPDATE users SET nama = $1, email = $2, phone = $3, gender = $4, address = $5, updated_at = CURRENT_TIMESTAMP
       WHERE id = $6
       RETURNING id, nama, email, phone, gender, address, member_id, poin_literasi`,
      [nama, email, phone, gender, address, req.user.id]
    );
    res.json({ status: 'success', profile: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GANTI PASSWORD
app.put('/api/profile/password', authenticateToken, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  try {
    const userResult = await pool.query('SELECT password FROM users WHERE id = $1', [req.user.id]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'User tidak ditemukan' });
    }

    const match = await bcrypt.compare(oldPassword, userResult.rows[0].password);
    if (!match) {
      return res.status(400).json({ status: 'error', message: 'Kata sandi saat ini salah' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [newHash, req.user.id]);

    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// UPLOAD FOTO PROFIL
app.post('/api/profile/photo', authenticateToken, (req, res) => {
  uploadPhoto.single('photo')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ status: 'error', message: err.message || 'Gagal mengunggah foto' });
    }

    try {
      if (!req.file) {
        return res.status(400).json({ status: 'error', message: 'Tidak ada file yang diunggah' });
      }

      const oldResult = await pool.query('SELECT photo_url FROM users WHERE id = $1', [req.user.id]);
      const oldPhotoUrl = oldResult.rows[0]?.photo_url;
      if (oldPhotoUrl) {
        const oldPath = path.join(__dirname, oldPhotoUrl);
        fs.unlink(oldPath, (err) => {
          if (err) console.log('Gagal hapus foto lama:', err.message);
        });
      }

      const photoUrl = `/uploads/${req.file.filename}`;
      await pool.query('UPDATE users SET photo_url = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [photoUrl, req.user.id]);

      res.json({ status: 'success', photo_url: photoUrl });
    } catch (err2) {
      res.status(500).json({ status: 'error', message: err2.message });
    }
  });
});

// HAPUS FOTO PROFIL
app.delete('/api/profile/photo', authenticateToken, async (req, res) => {
  try {
    const oldResult = await pool.query('SELECT photo_url FROM users WHERE id = $1', [req.user.id]);
    const oldPhotoUrl = oldResult.rows[0]?.photo_url;
    if (oldPhotoUrl) {
      const oldPath = path.join(__dirname, oldPhotoUrl);
      fs.unlink(oldPath, (err) => {
        if (err) console.log('Gagal hapus foto lama:', err.message);
      });
    }

    await pool.query('UPDATE users SET photo_url = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [req.user.id]);
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET SEMUA KATEGORI (untuk admin)
app.get('/api/admin/categories', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.id, c.nama AS name, c.description,
             (SELECT COUNT(*) FROM books b WHERE b.category_id = c.id) AS jumlah_buku
      FROM categories c
      ORDER BY c.nama ASC
    `);
    res.json({ status: 'success', categories: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// TAMBAH KATEGORI
app.post('/api/admin/categories', authenticateToken, requireAdmin, async (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ status: 'error', message: 'Nama kategori wajib diisi' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO categories (nama, description) VALUES ($1, $2) RETURNING id, nama AS name, description',
      [name.trim(), description || '']
    );
    res.json({ status: 'success', category: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ status: 'error', message: 'Kategori dengan nama itu sudah ada' });
    }
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// EDIT KATEGORI
app.put('/api/admin/categories/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { name, description } = req.body;
  try {
    const result = await pool.query(
      'UPDATE categories SET nama = $1, description = $2 WHERE id = $3 RETURNING id, nama AS name, description',
      [name.trim(), description || '', req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'Kategori tidak ditemukan' });
    }
    res.json({ status: 'success', category: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ status: 'error', message: 'Kategori dengan nama itu sudah ada' });
    }
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// HAPUS KATEGORI
app.delete('/api/admin/categories/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const usageCheck = await pool.query('SELECT COUNT(*) FROM books WHERE category_id = $1', [req.params.id]);
    if (parseInt(usageCheck.rows[0].count) > 0) {
      return res.status(400).json({ status: 'error', message: 'Kategori masih dipakai oleh buku, tidak bisa dihapus' });
    }
    await pool.query('DELETE FROM categories WHERE id = $1', [req.params.id]);
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET SEMUA BUKU (untuk admin — detail lengkap)
app.get('/api/admin/books', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        b.id, b.judul AS title, b.penulis AS author, b.penerbit AS publisher,
        b.tahun_terbit AS year, b.isbn, b.jenis_format AS format, b.deskripsi AS description,
        b.stok AS "availableQty", b.category_id, b.cover_url AS "coverUrl",
        b.jumlah_halaman AS "pageCount", b.file_url AS "fileUrl", b.format_file AS "formatFile",
        c.nama AS category,
        (SELECT COUNT(*) FROM loans l WHERE l.book_id = b.id AND l.status = 'aktif') AS "borrowedQty",
        (SELECT COUNT(*) FROM queue q WHERE q.book_id = b.id AND q.status = 'menunggu') AS "queueQty"
      FROM books b
      LEFT JOIN categories c ON b.category_id = c.id
      ORDER BY b.created_at DESC
    `);

    const books = result.rows.map((b) => {
      const availableQty = parseInt(b.availableQty) || 0;
      const borrowedQty = parseInt(b.borrowedQty) || 0;
      let accessStatus = 'Tidak Tersedia';
      if (availableQty > 0) accessStatus = 'Tersedia';
      else if (borrowedQty > 0) accessStatus = 'Sedang Dipinjam';

      return {
        ...b,
        availableQty,
        borrowedQty,
        stockLabel: `${availableQty} / ${availableQty + borrowedQty} unit`,
        accessStatus,
      };
    });

    res.json({ status: 'success', books });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// TAMBAH BUKU
app.post('/api/admin/books', authenticateToken, requireAdmin, async (req, res) => {
  const { title, author, publisher, year, isbn, category_id, format, description, availableQty, pageCount } = req.body;

  if (!title || !author) {
    return res.status(400).json({ status: 'error', message: 'Judul dan pengarang wajib diisi' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO books (judul, penulis, penerbit, tahun_terbit, isbn, category_id, jenis_format, deskripsi, stok, jumlah_halaman)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [title, author, publisher || null, year || null, isbn || null, category_id || null, format || 'Fisik', description || '', availableQty ?? 1, pageCount || null]
    );
    res.json({ status: 'success', id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// EDIT BUKU
app.put('/api/admin/books/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { title, author, publisher, year, isbn, category_id, format, description, availableQty, pageCount } = req.body;

  try {
    const result = await pool.query(
      `UPDATE books SET judul = $1, penulis = $2, penerbit = $3, tahun_terbit = $4, isbn = $5,
       category_id = $6, jenis_format = $7, deskripsi = $8, stok = $9, jumlah_halaman = $10, updated_at = CURRENT_TIMESTAMP
       WHERE id = $11 RETURNING id`,
      [title, author, publisher || null, year || null, isbn || null, category_id || null, format || 'Fisik', description || '', availableQty ?? 0, pageCount || null, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'Buku tidak ditemukan' });
    }
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// HAPUS BUKU
app.delete('/api/admin/books/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM books WHERE id = $1', [req.params.id]);
    res.json({ status: 'success' });
  } catch (err) {
    if (err.code === '23503') {
      return res.status(400).json({ status: 'error', message: 'Buku tidak bisa dihapus karena masih memiliki riwayat peminjaman/favorit/disimpan' });
    }
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// UPLOAD COVER BUKU
app.post('/api/admin/books/:id/cover', authenticateToken, requireAdmin, (req, res) => {
  uploadCover.single('cover')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ status: 'error', message: err.message || 'Gagal mengunggah cover' });
    }
    try {
      if (!req.file) {
        return res.status(400).json({ status: 'error', message: 'Tidak ada file yang diunggah' });
      }

      const bookResult = await pool.query('SELECT cover_url FROM books WHERE id = $1', [req.params.id]);
      if (bookResult.rows.length === 0) {
        return res.status(404).json({ status: 'error', message: 'Buku tidak ditemukan' });
      }

      const oldCoverUrl = bookResult.rows[0].cover_url;
      if (oldCoverUrl) {
        const oldPath = path.join(__dirname, oldCoverUrl);
        fs.unlink(oldPath, (err) => {
          if (err) console.log('Gagal hapus cover lama:', err.message);
        });
      }

      const coverUrl = `/uploads/${req.file.filename}`;
      await pool.query('UPDATE books SET cover_url = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [coverUrl, req.params.id]);

      res.json({ status: 'success', cover_url: coverUrl });
    } catch (err2) {
      res.status(500).json({ status: 'error', message: err2.message });
    }
  });
});

// UPLOAD FILE PDF BUKU
app.post('/api/admin/books/:id/pdf', authenticateToken, requireAdmin, (req, res) => {
  uploadBookPdf.single('pdf')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ status: 'error', message: err.message || 'Gagal mengunggah PDF' });
    }
    try {
      if (!req.file) {
        return res.status(400).json({ status: 'error', message: 'Tidak ada file yang diunggah' });
      }

      const bookResult = await pool.query('SELECT file_url FROM books WHERE id = $1', [req.params.id]);
      if (bookResult.rows.length === 0) {
        return res.status(404).json({ status: 'error', message: 'Buku tidak ditemukan' });
      }

      const oldFileUrl = bookResult.rows[0].file_url;
      if (oldFileUrl) {
        const oldPath = path.join(__dirname, oldFileUrl);
        fs.unlink(oldPath, (err) => {
          if (err) console.log('Gagal hapus PDF lama:', err.message);
        });
      }

      const fileUrl = `/uploads/${req.file.filename}`;
      const sizeMb = (req.file.size / (1024 * 1024)).toFixed(1);
      const formatFile = `PDF (${sizeMb} MB)`;

      await pool.query(
        'UPDATE books SET file_url = $1, format_file = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        [fileUrl, formatFile, req.params.id]
      );

      res.json({ status: 'success', file_url: fileUrl, format_file: formatFile });
    } catch (err2) {
      res.status(500).json({ status: 'error', message: err2.message });
    }
  });
});

// GET SEMUA PEMINJAMAN (untuk admin)
app.get('/api/admin/loans', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await processExpiredLoans();

    const result = await pool.query(`
      SELECT l.id, l.tanggal_pinjam, l.tanggal_kembali, l.tanggal_dikembalikan, l.status,
             b.id AS book_id, b.judul AS "bookTitle", b.jenis_format AS format, b.cover_url AS "coverUrl",
             u.id AS member_id, u.nama AS "memberName", u.member_id AS "memberCode"
      FROM loans l
      JOIN books b ON l.book_id = b.id
      JOIN users u ON l.user_id = u.id
      ORDER BY l.tanggal_pinjam DESC
    `);

    const statusLabel = { aktif: 'Dipinjam', dikembalikan: 'Dikembalikan', berakhir_otomatis: 'Berakhir Otomatis' };

    const loans = result.rows.map((l) => ({
      id: l.id,
      bookId: l.book_id,
      bookTitle: l.bookTitle,
      format: l.format,
      coverUrl: l.coverUrl,
      memberId: l.member_id,
      memberName: l.memberName,
      memberCode: l.memberCode,
      borrowDate: l.tanggal_pinjam,
      dueDate: l.tanggal_kembali,
      returnDate: l.tanggal_dikembalikan,
      status: statusLabel[l.status] || l.status,
    }));

    res.json({ status: 'success', loans });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ADMIN: TANDAI DIKEMBALIKAN (bisa untuk siapa saja, tidak terbatas punya sendiri)
app.post('/api/admin/loans/:id/return', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await closePulenLoanSafely({pool, loanId: req.params.id});
    if (!result.changed) return res.status(result.reason === 'invalid' ? 400 : 404).json({
      status: 'error', message: 'Peminjaman tidak ditemukan atau sudah selesai'
    });
    return res.json({status:'success', message:'Buku berhasil dikembalikan'});
  } catch (error) {
    console.error('[PULEN ADMIN RETURN]', error.code || 'error');
    return res.status(500).json({status:'error', message:'Pengembalian belum berhasil. Silakan coba lagi.'});
  }
});

// ADMIN: PERPANJANG JATUH TEMPO (+7 hari)
app.put('/api/admin/loans/:id/extend', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const settingsResult = await pool.query('SELECT allow_extension FROM settings WHERE id = 1');
    if (settingsResult.rows[0] && settingsResult.rows[0].allow_extension === false) {
      return res.status(400).json({ status: 'error', message: 'Perpanjangan peminjaman sedang dinonaktifkan di Pengaturan Sistem' });
    }

    const result = await pool.query(
      "UPDATE loans SET tanggal_kembali = tanggal_kembali + INTERVAL '7 days' WHERE id = $1 AND status = 'aktif' RETURNING tanggal_kembali",
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'Data peminjaman tidak ditemukan atau sudah selesai' });
    }
    res.json({ status: 'success', tanggal_kembali: result.rows[0].tanggal_kembali });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET SEMUA ANGGOTA (bukan admin)
app.get('/api/admin/members', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, nama AS name, email, phone, category, member_id AS "memberCode",
             member_status AS status, created_at AS "joinDate"
      FROM users
      WHERE is_admin = false
      ORDER BY created_at DESC
    `);
    res.json({ status: 'success', members: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ADMIN: UBAH STATUS ANGGOTA (Aktif / Diblokir)
app.put('/api/admin/members/:id/status', authenticateToken, requireAdmin, async (req, res) => {
  const { status } = req.body;
  try {
    const result = await pool.query(
      'UPDATE users SET member_status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND is_admin = false RETURNING id',
      [status, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'Anggota tidak ditemukan' });
    }
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Format angka ala Indonesia (12480 -> "12.480") tanpa bergantung locale Node
function formatID(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function relativeTimeServer(iso) {
  const date = new Date(iso);
  const diffMin = Math.floor((Date.now() - date.getTime()) / 60000);
  if (diffMin < 1) return 'Baru saja';
  if (diffMin < 60) return `${diffMin} menit lalu`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} jam lalu`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay} hari lalu`;
}

// GET PENGATURAN SISTEM
app.get('/api/admin/settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM settings WHERE id = 1');
    res.json({ status: 'success', settings: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// UPDATE PENGATURAN SISTEM
app.put('/api/admin/settings', authenticateToken, requireAdmin, async (req, res) => {
  const {
    library_name, address, phone, email, hours,
    loan_duration_days, max_books_per_member, allow_extension, auto_queue,
    notify_due, notify_available, notify_email, reminder_days,
    auto_backup, backup_period,
  } = req.body;
  try {
    const result = await pool.query(
      `UPDATE settings SET
        library_name = $1, address = $2, phone = $3, email = $4, hours = $5,
        loan_duration_days = $6, max_books_per_member = $7, allow_extension = $8, auto_queue = $9,
        notify_due = $10, notify_available = $11, notify_email = $12, reminder_days = $13,
        auto_backup = $14, backup_period = $15, updated_at = CURRENT_TIMESTAMP
       WHERE id = 1
       RETURNING *`,
      [library_name, address, phone, email, hours,
       loan_duration_days, max_books_per_member, allow_extension, auto_queue,
       notify_due, notify_available, notify_email, reminder_days,
       auto_backup, backup_period]
    );
    res.json({ status: 'success', settings: result.rows[0] });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET DAFTAR AKUN ADMIN
app.get('/api/admin/admins', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, nama AS name, email, created_at FROM users WHERE is_admin = true ORDER BY created_at ASC"
    );
    res.json({ status: 'success', admins: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET LAPORAN & ANALITIK
app.get('/api/admin/reports', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const range = req.query.range || 'month';
    const rangeDays = { week: 7, month: 30, quarter: 90, year: 365, custom: 30 }[range] || 30;

    const periodStart = new Date(Date.now() - rangeDays * 86400000);
    const prevPeriodStart = new Date(periodStart.getTime() - rangeDays * 86400000);

    // ===== Cards =====
    const totalBukuResult = await pool.query('SELECT COUNT(*) FROM books');
    const bukuBaruIni = await pool.query('SELECT COUNT(*) FROM books WHERE created_at >= $1', [periodStart]);
    const bukuBaruLalu = await pool.query('SELECT COUNT(*) FROM books WHERE created_at >= $1 AND created_at < $2', [prevPeriodStart, periodStart]);
    const totalBuku = parseInt(totalBukuResult.rows[0].count);
    const bukuIni = parseInt(bukuBaruIni.rows[0].count);
    const bukuLalu = parseInt(bukuBaruLalu.rows[0].count);
    const bukuChange = bukuLalu > 0 ? ((bukuIni - bukuLalu) / bukuLalu) * 100 : (bukuIni > 0 ? 100 : 0);

    const peminjamanIni = await pool.query('SELECT COUNT(*) FROM loans WHERE tanggal_pinjam >= $1', [periodStart]);
    const peminjamanLalu = await pool.query('SELECT COUNT(*) FROM loans WHERE tanggal_pinjam >= $1 AND tanggal_pinjam < $2', [prevPeriodStart, periodStart]);
    const totalPeminjamanIni = parseInt(peminjamanIni.rows[0].count);
    const totalPeminjamanLalu = parseInt(peminjamanLalu.rows[0].count);
    const peminjamanChange = totalPeminjamanLalu > 0 ? ((totalPeminjamanIni - totalPeminjamanLalu) / totalPeminjamanLalu) * 100 : (totalPeminjamanIni > 0 ? 100 : 0);

    const anggotaAktifResult = await pool.query("SELECT COUNT(*) FROM users WHERE is_admin = false AND member_status = 'Aktif'");
    const anggotaBaruIni = await pool.query('SELECT COUNT(*) FROM users WHERE is_admin = false AND created_at >= $1', [periodStart]);
    const anggotaBaruLalu = await pool.query('SELECT COUNT(*) FROM users WHERE is_admin = false AND created_at >= $1 AND created_at < $2', [prevPeriodStart, periodStart]);
    const totalAnggotaAktif = parseInt(anggotaAktifResult.rows[0].count);
    const anggotaIni = parseInt(anggotaBaruIni.rows[0].count);
    const anggotaLalu = parseInt(anggotaBaruLalu.rows[0].count);
    const anggotaChange = anggotaLalu > 0 ? ((anggotaIni - anggotaLalu) / anggotaLalu) * 100 : (anggotaIni > 0 ? 100 : 0);

    const berakhirIni = await pool.query("SELECT COUNT(*) FROM loans WHERE status = 'berakhir_otomatis' AND tanggal_dikembalikan >= $1", [periodStart]);
    const berakhirLalu = await pool.query("SELECT COUNT(*) FROM loans WHERE status = 'berakhir_otomatis' AND tanggal_dikembalikan >= $1 AND tanggal_dikembalikan < $2", [prevPeriodStart, periodStart]);
    const totalBerakhirIni = parseInt(berakhirIni.rows[0].count);
    const totalBerakhirLalu = parseInt(berakhirLalu.rows[0].count);
    const berakhirChange = totalBerakhirLalu > 0 ? ((totalBerakhirIni - totalBerakhirLalu) / totalBerakhirLalu) * 100 : (totalBerakhirIni > 0 ? 100 : 0);

    // ===== Tren 12 Bulan =====
    const trendResult = await pool.query(`
      SELECT TO_CHAR(gs, 'Mon') AS month,
             (SELECT COUNT(*) FROM loans WHERE date_trunc('month', tanggal_pinjam) = date_trunc('month', gs)) AS loans,
             (SELECT COUNT(*) FROM loans WHERE date_trunc('month', tanggal_dikembalikan) = date_trunc('month', gs) AND status IN ('dikembalikan','berakhir_otomatis')) AS returns
      FROM generate_series(date_trunc('month', NOW()) - INTERVAL '11 months', date_trunc('month', NOW()), INTERVAL '1 month') AS gs
      ORDER BY gs
    `);
    const monthMap = { Jan: 'Jan', Feb: 'Feb', Mar: 'Mar', Apr: 'Apr', May: 'Mei', Jun: 'Jun', Jul: 'Jul', Aug: 'Agu', Sep: 'Sep', Oct: 'Okt', Nov: 'Nov', Dec: 'Des' };
    const monthlyTrend = trendResult.rows.map((r) => ({
      month: monthMap[r.month] || r.month,
      loans: parseInt(r.loans),
      returns: parseInt(r.returns),
    }));

    // ===== Distribusi Kategori =====
    const categoryResult = await pool.query(`
      SELECT c.nama AS name, COUNT(l.id) AS count
      FROM loans l
      JOIN books b ON l.book_id = b.id
      LEFT JOIN categories c ON b.category_id = c.id
      WHERE l.tanggal_pinjam >= $1
      GROUP BY c.nama
      ORDER BY count DESC
    `, [periodStart]);
    const totalLoansForCategory = categoryResult.rows.reduce((sum, r) => sum + parseInt(r.count), 0);
    const CATEGORY_COLORS = ['#059669', '#0284c7', '#d97706', '#4f46e5', '#db2777', '#0f766e'];
    const categoryDistribution = categoryResult.rows.slice(0, 6).map((r, i) => ({
      name: r.name || 'Lainnya',
      value: totalLoansForCategory > 0 ? Math.round((parseInt(r.count) / totalLoansForCategory) * 100) : 0,
      color: CATEGORY_COLORS[i % CATEGORY_COLORS.length],
    }));

    // ===== Buku Terpopuler =====
    const popularResult = await pool.query(`
      SELECT b.judul AS title, c.nama AS category, b.stok AS stock, COUNT(l.id) AS borrowed
      FROM loans l
      JOIN books b ON l.book_id = b.id
      LEFT JOIN categories c ON b.category_id = c.id
      WHERE l.tanggal_pinjam >= $1
      GROUP BY b.id, c.nama
      ORDER BY borrowed DESC
      LIMIT 10
    `, [periodStart]);
    const popularBooks = popularResult.rows.map((r, i) => ({
      rank: i + 1,
      title: r.title,
      category: r.category || '-',
      borrowed: parseInt(r.borrowed),
      stock: r.stock,
    }));

    // ===== Anggota Paling Aktif =====
    const activeMembersResult = await pool.query(`
      SELECT u.nama AS name, u.member_id AS "memberId", u.poin_literasi AS points,
             COUNT(l.id) AS total,
             SUM(CASE WHEN l.status = 'aktif' THEN 1 ELSE 0 END) AS active
      FROM users u
      JOIN loans l ON l.user_id = u.id
      WHERE u.is_admin = false AND l.tanggal_pinjam >= $1
      GROUP BY u.id
      ORDER BY total DESC
      LIMIT 10
    `, [periodStart]);
    const activeMembers = activeMembersResult.rows.map((r) => ({
      name: r.name,
      memberId: r.memberId,
      total: parseInt(r.total),
      active: parseInt(r.active),
      points: r.points,
    }));

    // ===== Aktivitas Terbaru =====
    const recentLoansResult = await pool.query(`
      SELECT l.status, l.tanggal_pinjam, l.tanggal_dikembalikan, b.judul AS book_title, u.nama AS member_name
      FROM loans l
      JOIN books b ON l.book_id = b.id
      JOIN users u ON l.user_id = u.id
      ORDER BY GREATEST(l.tanggal_pinjam, COALESCE(l.tanggal_dikembalikan, l.tanggal_pinjam)) DESC
      LIMIT 20
    `);
    const recentMembersResult = await pool.query(`
      SELECT nama, created_at FROM users WHERE is_admin = false ORDER BY created_at DESC LIMIT 10
    `);

    const activityEvents = [];
    recentLoansResult.rows.forEach((l) => {
      activityEvents.push({ type: 'borrow', title: `Buku "${l.book_title}" dipinjam oleh ${l.member_name}`, time: l.tanggal_pinjam });
      if (l.status === 'dikembalikan' && l.tanggal_dikembalikan) {
        activityEvents.push({ type: 'return', title: `Buku "${l.book_title}" dikembalikan oleh ${l.member_name}`, time: l.tanggal_dikembalikan });
      }
      if (l.status === 'berakhir_otomatis' && l.tanggal_dikembalikan) {
        activityEvents.push({ type: 'ended', title: `Peminjaman "${l.book_title}" berakhir otomatis`, time: l.tanggal_dikembalikan });
      }
    });
    recentMembersResult.rows.forEach((m) => {
      activityEvents.push({ type: 'member', title: `Anggota baru mendaftar: ${m.nama}`, time: m.created_at });
    });

    const recentActivities = activityEvents
      .sort((a, b) => new Date(b.time) - new Date(a.time))
      .slice(0, 8)
      .map((e) => ({ type: e.type, title: e.title, time: relativeTimeServer(e.time) }));

    res.json({
      status: 'success',
      report: {
        range,
        cards: [
          { label: 'Total Buku', value: formatID(totalBuku), change: Math.abs(Math.round(bukuChange * 10) / 10), direction: bukuChange >= 0 ? 'up' : 'down', tone: 'emerald' },
          { label: 'Total Peminjaman', value: formatID(totalPeminjamanIni), change: Math.abs(Math.round(peminjamanChange * 10) / 10), direction: peminjamanChange >= 0 ? 'up' : 'down', tone: 'blue' },
          { label: 'Anggota Aktif', value: formatID(totalAnggotaAktif), change: Math.abs(Math.round(anggotaChange * 10) / 10), direction: anggotaChange >= 0 ? 'up' : 'down', tone: 'emerald' },
          { label: 'Berakhir Otomatis', value: formatID(totalBerakhirIni), change: Math.abs(Math.round(berakhirChange * 10) / 10), direction: berakhirChange >= 0 ? 'up' : 'down', tone: 'red' },
        ],
        monthlyTrend,
        categoryDistribution,
        popularBooks,
        activeMembers,
        recentActivities,
      },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// MINTA KODE OTP UNTUK PINJAM BUKU
app.post('/api/loans/request-otp', authenticateToken, async (req, res) => {
  const { book_id } = req.body;
  const user_id = req.user.id;

  try {
    const userResult = await pool.query('SELECT nama, email FROM users WHERE id = $1', [user_id]);
    const bookResult = await pool.query('SELECT judul, stok FROM books WHERE id = $1', [book_id]);

    if (userResult.rows.length === 0 || bookResult.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'Data tidak ditemukan' });
    }
    if (bookResult.rows[0].stok <= 0) {
      return res.status(400).json({ status: 'error', message: 'Buku sedang tidak tersedia' });
    }

    const existing = await pool.query(
      "SELECT id FROM loans WHERE user_id = $1 AND book_id = $2 AND status = 'aktif'",
      [user_id, book_id]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ status: 'error', message: 'Anda sudah meminjam buku ini' });
    }

    const code = generateOtpCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      'INSERT INTO loan_otps (user_id, book_id, code, expires_at) VALUES ($1, $2, $3, $4)',
      [user_id, book_id, code, expiresAt]
    );

    await emailTransporter.sendMail({
      from: `"Perpustakaan Kota Payakumbuh" <${process.env.EMAIL_USER}>`,
      to: userResult.rows[0].email,
      subject: 'Kode Verifikasi Peminjaman Buku',
      html: `
        <p>Halo ${userResult.rows[0].nama},</p>
        <p>Kode verifikasi untuk meminjam buku <strong>"${bookResult.rows[0].judul}"</strong>:</p>
        <h2 style="letter-spacing: 4px;">${code}</h2>
        <p>Kode ini berlaku selama 10 menit. Jangan bagikan kode ini kepada siapapun.</p>
      `,
    });

    res.json({ status: 'success', message: 'Kode verifikasi telah dikirim ke email Anda' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// KONFIRMASI OTP DAN PROSES PEMINJAMAN
app.post('/api/loans/confirm-otp', authenticateToken, async (req, res) => {
  const { book_id, code } = req.body;
  const user_id = req.user.id;

  try {
    const otpResult = await pool.query(
      `SELECT * FROM loan_otps WHERE user_id = $1 AND book_id = $2 AND code = $3 AND used = false
       ORDER BY created_at DESC LIMIT 1`,
      [user_id, book_id, code]
    );

    if (otpResult.rows.length === 0) {
      return res.status(400).json({ status: 'error', message: 'Kode verifikasi salah' });
    }
    if (new Date(otpResult.rows[0].expires_at) < new Date()) {
      return res.status(400).json({ status: 'error', message: 'Kode verifikasi sudah kedaluwarsa, silakan minta kode baru' });
    }

    const settingsResult = await pool.query('SELECT loan_duration_days, max_books_per_member FROM settings WHERE id = 1');
    const settings = settingsResult.rows[0] || { loan_duration_days: 7, max_books_per_member: 3 };

    const activeCountResult = await pool.query("SELECT COUNT(*) FROM loans WHERE user_id = $1 AND status = 'aktif'", [user_id]);
    if (parseInt(activeCountResult.rows[0].count) >= settings.max_books_per_member) {
      return res.status(400).json({ status: 'error', message: `Anda sudah mencapai batas maksimal ${settings.max_books_per_member} buku yang dipinjam` });
    }

    const bookResult = await pool.query(`
      SELECT id, judul, penulis, penerbit, tahun_terbit, isbn, jenis_format,
             deskripsi, stok, jumlah_halaman, cover_url, file_url
      FROM books
      WHERE id = $1
    `, [book_id]);
    if (bookResult.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'Buku tidak ditemukan' });
    }
    if (bookResult.rows[0].stok <= 0) {
      return res.status(400).json({ status: 'error', message: 'Buku sedang tidak tersedia' });
    }

    const tanggalKembali = new Date();
    tanggalKembali.setDate(tanggalKembali.getDate() + settings.loan_duration_days);

    const loanResult = await pool.query(
      `INSERT INTO loans (user_id, book_id, status, tanggal_pinjam, tanggal_kembali)
       VALUES ($1, $2, 'aktif', CURRENT_TIMESTAMP, $3)
       RETURNING id, tanggal_pinjam, tanggal_kembali`,
      [user_id, book_id, tanggalKembali]
    );

    await pool.query('UPDATE books SET stok = stok - 1 WHERE id = $1', [book_id]);
    await pool.query('UPDATE loan_otps SET used = true WHERE id = $1', [otpResult.rows[0].id]);

    await createNotification(
      user_id, 'borrow', 'Peminjaman Dikonfirmasi',
      `Buku telah berhasil dipinjam. Batas waktu pengembalian: ${settings.loan_duration_days} hari.`
    );

    res.json({
      status: 'success',
      loan: {
        ...loanResult.rows[0],
        book: bookResult.rows[0],
      },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// VERIFIKASI EMAIL SETELAH REGISTER
app.post('/api/verify-email', async (req, res) => {
  const { email, code } = req.body;

  try {
    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'Akun tidak ditemukan' });
    }
    const user = userResult.rows[0];

    if (user.email_verified) {
      return res.status(400).json({ status: 'error', message: 'Email sudah diverifikasi sebelumnya' });
    }

    const codeResult = await pool.query(
      `SELECT * FROM email_verifications WHERE user_id = $1 AND code = $2 AND used = false
       ORDER BY created_at DESC LIMIT 1`,
      [user.id, code]
    );
    if (codeResult.rows.length === 0) {
      return res.status(400).json({ status: 'error', message: 'Kode verifikasi salah' });
    }
    if (new Date(codeResult.rows[0].expires_at) < new Date()) {
      return res.status(400).json({ status: 'error', message: 'Kode verifikasi sudah kedaluwarsa, silakan minta kode baru' });
    }

    await pool.query('UPDATE users SET email_verified = true WHERE id = $1', [user.id]);
    await pool.query('UPDATE email_verifications SET used = true WHERE id = $1', [codeResult.rows[0].id]);

    res.json({ status: 'success', message: 'Email berhasil diverifikasi, silakan login' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// KIRIM ULANG KODE VERIFIKASI
app.post('/api/resend-verification', async (req, res) => {
  const { email } = req.body;

  try {
    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'Akun tidak ditemukan' });
    }
    const user = userResult.rows[0];

    if (user.email_verified) {
      return res.status(400).json({ status: 'error', message: 'Email sudah diverifikasi' });
    }

    const code = generateOtpCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query(
      'INSERT INTO email_verifications (user_id, code, expires_at) VALUES ($1, $2, $3)',
      [user.id, code, expiresAt]
    );

    await emailTransporter.sendMail({
      from: `"Perpustakaan Kota Payakumbuh" <${process.env.EMAIL_USER}>`,
      to: user.email,
      subject: 'Verifikasi Email Pendaftaran',
      html: `
        <p>Halo ${user.nama},</p>
        <p>Kode verifikasi email Anda:</p>
        <h2 style="letter-spacing: 4px;">${code}</h2>
        <p>Kode ini berlaku selama 10 menit.</p>
      `,
    });

    res.json({ status: 'success', message: 'Kode verifikasi baru telah dikirim' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET NOTIFIKASI SAYA
app.get('/api/notifications/my', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    res.json({ status: 'success', notifications: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// TANDAI SATU NOTIFIKASI DIBACA
app.put('/api/notifications/:id/read', authenticateToken, async (req, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// TANDAI SEMUA DIBACA
app.put('/api/notifications/read-all', authenticateToken, async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET is_read = true WHERE user_id = $1', [req.user.id]);
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// HAPUS NOTIFIKASI
app.delete('/api/notifications/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM notifications WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// AMBIL ANTRIAN SAYA YANG SEDANG AKTIF
app.get('/api/queue/my', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT q.id AS queue_id, q.posisi, q.book_id,
             b.judul, b.penulis, b.cover_url,
             (SELECT COUNT(*) FROM queue q2 WHERE q2.book_id = q.book_id AND q2.status = 'menunggu') AS total_queue,
             (SELECT MIN(l.tanggal_kembali) FROM loans l WHERE l.book_id = q.book_id AND l.status = 'aktif') AS estimated_date
      FROM queue q
      JOIN books b ON q.book_id = b.id
      WHERE q.user_id = $1 AND q.status = 'menunggu'
      ORDER BY q.posisi ASC
    `, [req.user.id]);
    res.json({ status: 'success', queues: result.rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// AMBIL DAFTAR LENGKAP ANTRIAN UNTUK SATU BUKU
app.get('/api/queue/book/:bookId', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT q.id, q.posisi, q.user_id, u.nama, u.member_id
      FROM queue q JOIN users u ON q.user_id = u.id
      WHERE q.book_id = $1 AND q.status = 'menunggu'
      ORDER BY q.posisi ASC
    `, [req.params.bookId]);
    res.json({ status: 'success', queue: result.rows, currentUserId: req.user.id });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// BATALKAN ANTRIAN
app.delete('/api/queue/:id', authenticateToken, async (req, res) => {
  try {
    const q = await pool.query(
      "SELECT * FROM queue WHERE id = $1 AND user_id = $2 AND status = 'menunggu'",
      [req.params.id, req.user.id]
    );
    if (q.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'Antrian tidak ditemukan' });
    }
    const { book_id, posisi } = q.rows[0];
    await pool.query('DELETE FROM queue WHERE id = $1', [req.params.id]);
    await pool.query(
      "UPDATE queue SET posisi = posisi - 1 WHERE book_id = $1 AND status = 'menunggu' AND posisi > $2",
      [book_id, posisi]
    );
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ADMIN: KIRIM NOTIFIKASI MANUAL (broadcast ke semua anggota, atau ke satu anggota)
app.post('/api/admin/notifications/broadcast', authenticateToken, requireAdmin, async (req, res) => {
  const { title, message, userId } = req.body;
  if (!title || !message) {
    return res.status(400).json({ status: 'error', message: 'Judul dan pesan wajib diisi' });
  }
  try {
    if (userId) {
      await createNotification(userId, 'promotion', title, message);
    } else {
      const members = await pool.query('SELECT id FROM users WHERE is_admin = false');
      for (const m of members.rows) {
        await createNotification(m.id, 'promotion', title, message);
      }
    }
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server jalan di http://localhost:${PORT}`);
});