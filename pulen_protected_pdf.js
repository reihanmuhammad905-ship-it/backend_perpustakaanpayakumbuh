'use strict';

// Membaca PDF hanya untuk pinjaman yang masih aktif dan milik JWT PULEN.
// Tidak mengizinkan klien memilih path file.
const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = function createPulenProtectedPdfRouter({ pool, authenticateToken }) {
  const router = express.Router();

  router.get('/:loanId/read-pdf', authenticateToken, async (req, res) => {
    const loanId = Number(req.params.loanId);
    const userId = Number(req.user && req.user.id);
    if (!Number.isSafeInteger(loanId) || loanId <= 0 ||
        !Number.isSafeInteger(userId) || userId <= 0 ||
        req.user.scope !== 'pulen-member') {
      return res.status(403).json({status:'error', message:'Tidak memiliki akses membaca buku ini'});
    }
    try {
      const result = await pool.query(`
        SELECT b.id AS book_id, b.file_url
        FROM loans l JOIN books b ON b.id = l.book_id
        WHERE l.id = $1 AND l.user_id = $2 AND l.status = 'aktif'
          AND (l.tanggal_kembali IS NULL OR l.tanggal_kembali > NOW())
        LIMIT 1
      `, [loanId, userId]);
      if (!result.rows.length) {
        return res.status(403).json({status:'error', message:'Pinjaman tidak aktif atau bukan milik akun Anda'});
      }
      const url = String(result.rows[0].file_url || '').trim();
      if (!url) return res.status(404).json({status:'error', message:'PDF buku belum tersedia'});
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(url, 'http://pulen.local').pathname);
      } catch (_) {
        return res.status(404).json({status:'error', message:'Alamat PDF buku tidak valid'});
      }
      if (!pathname.startsWith('/uploads/') || path.extname(pathname).toLowerCase() !== '.pdf') {
        return res.status(404).json({status:'error', message:'Lokasi PDF tidak didukung'});
      }
      const root = await fs.promises.realpath(path.resolve(process.cwd(), 'uploads'));
      const candidate = path.resolve(root, pathname.substring('/uploads/'.length));
      if (!candidate.startsWith(root + path.sep)) {
        return res.status(403).json({status:'error', message:'Lokasi file tidak diizinkan'});
      }
      let realFile;
      try { realFile = await fs.promises.realpath(candidate); }
      catch (_) { return res.status(404).json({status:'error', message:'File PDF belum tersedia pada server'}); }
      if (!realFile.startsWith(root + path.sep) || path.extname(realFile).toLowerCase() !== '.pdf') {
        return res.status(403).json({status:'error', message:'Lokasi file tidak diizinkan'});
      }
      const info = await fs.promises.stat(realFile);
      if (!info.isFile()) return res.status(404).json({status:'error', message:'File PDF tidak ditemukan'});
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline');
      return res.sendFile(realFile, (err) => {
        if (!err) {
          // Catat hanya setelah PDF benar-benar berhasil ditransfer.
          // Kegagalan log tidak membocorkan PDF atau merusak pembaca.
          pool.query(`
            INSERT INTO public.pulen_reading_history (user_id, book_id)
            VALUES ($1, $2)
            ON CONFLICT (user_id, book_id) DO UPDATE
              SET last_opened_at = CURRENT_TIMESTAMP,
                  open_count = public.pulen_reading_history.open_count + 1
          `, [userId, result.rows[0].book_id]).catch((logError) => {
            console.error('[PULEN READ LOG] gagal:', logError && logError.code ? logError.code : 'internal_error');
          });
          return;
        }
        if (!res.headersSent) {
          return res.status(500).json({status:'error', message:'Gagal mengirim PDF'});
        }
      });
    } catch (error) {
      console.error('[PULEN PDF] gagal:', error && error.code ? error.code : 'internal_error');
      if (!res.headersSent) return res.status(500).json({status:'error', message:'Tidak bisa membuka PDF saat ini'});
    }
  });
  return router;
};
