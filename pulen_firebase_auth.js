'use strict';

// Modul terpisah: tidak mengubah /login PULEN lama atau autentikasi MyKopay.
// PILOT LOKAL: Firebase membuktikan identitas Google, BELUM status akun MyKopay.
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const https = require('https');

// Firebase public certificate endpoint, sesuai dokumentasi Firebase.
// Pilot ini memvalidasi signature/iss/aud/iat/exp, bukan revocation status.
const FIREBASE_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken%40system.gserviceaccount.com';
let certCache = null;
let certCacheExpires = 0;

function loadCertificates() {
  if (certCache && Date.now() < certCacheExpires) return Promise.resolve(certCache);
  return new Promise((resolve, reject) => {
    const request = https.get(FIREBASE_CERTS_URL, { timeout: 8000 }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error('FIREBASE_KEYS_UNAVAILABLE'));
      }
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 100000) response.destroy(new Error('FIREBASE_KEYS_TOO_LARGE'));
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const certs = JSON.parse(raw);
          if (!certs || typeof certs !== 'object' || Array.isArray(certs)) {
            throw new Error('FIREBASE_KEYS_INVALID');
          }
          const cacheHeader = String(response.headers['cache-control'] || '');
          const ageMatch = cacheHeader.match(/max-age=(\d+)/);
          const ageSeconds = ageMatch ? Number(ageMatch[1]) : 300;
          certCache = certs;
          certCacheExpires = Date.now() + Math.min(Math.max(ageSeconds, 60), 3600) * 1000;
          resolve(certs);
        } catch (_) {
          reject(new Error('FIREBASE_KEYS_INVALID'));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('FIREBASE_KEYS_TIMEOUT')));
    request.on('error', reject);
  });
}

async function verifyFirebaseIdToken(idToken, projectId, jwt) {
  const parsed = jwt.decode(idToken, { complete: true });
  const header = parsed && parsed.header;
  if (!header || header.alg !== 'RS256' ||
      typeof header.kid !== 'string' || !header.kid) {
    throw new Error('FIREBASE_TOKEN_HEADER_INVALID');
  }
  const certificates = await loadCertificates();
  const cert = Object.prototype.hasOwnProperty.call(certificates, header.kid)
    ? certificates[header.kid] : null;
  if (typeof cert !== 'string' || !cert) throw new Error('FIREBASE_KEY_NOT_FOUND');
  const decoded = jwt.verify(idToken, cert, {
    algorithms: ['RS256'],
    audience: projectId,
    issuer: `https://securetoken.google.com/${projectId}`,
  });
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!decoded || typeof decoded !== 'object' ||
      typeof decoded.sub !== 'string' || !decoded.sub ||
      typeof decoded.iat !== 'number' || decoded.iat > nowSeconds ||
      typeof decoded.auth_time !== 'number' || decoded.auth_time > nowSeconds) {
    throw new Error('FIREBASE_TOKEN_CLAIMS_INVALID');
  }
  return { ...decoded, uid: decoded.sub };
}

module.exports = function createPulenFirebaseRouter({ pool, jwt }) {
  const router = express.Router();

  router.post('/exchange', async (req, res) => {
    // Default MATI. Jangan aktifkan di production sebelum MyKopay membership diverifikasi.
    if (process.env.PULEN_FIREBASE_PILOT_ENABLED !== 'true') {
      return res.status(503).json({ status: 'error', message: 'Integrasi Firebase PULEN belum diaktifkan' });
    }
    if (!process.env.JWT_SECRET || !process.env.PULEN_FIREBASE_PROJECT_ID) {
      return res.status(503).json({ status: 'error', message: 'Konfigurasi autentikasi PULEN belum lengkap' });
    }
    const idToken = req.body && req.body.id_token;
    if (typeof idToken !== 'string' || idToken.length < 50 || idToken.length > 10000) {
      return res.status(400).json({ status: 'error', message: 'Firebase ID token tidak valid' });
    }

    let verified;
    try {
      // Memeriksa signature RS256, issuer, audience, masa aktif, auth_time.
      // Revocation/disabled-user checking memerlukan Firebase Admin SDK.
      verified = await verifyFirebaseIdToken(idToken, process.env.PULEN_FIREBASE_PROJECT_ID, jwt);
    } catch (e) {
      console.warn('[PULEN auth] Firebase token ditolak:', e && e.code ? e.code : 'verification_failed');
      return res.status(401).json({ status: 'error', message: 'Sesi Google tidak sah atau sudah berakhir' });
    }
    if (verified.email_verified !== true ||
        verified.firebase?.sign_in_provider !== 'google.com' ||
        typeof verified.email !== 'string' ||
        typeof verified.uid !== 'string' || !verified.uid) {
      return res.status(403).json({ status: 'error', message: 'Diperlukan akun Google dengan email terverifikasi' });
    }

    const email = verified.email.trim().toLowerCase();
    const name = (typeof verified.name === 'string' && verified.name.trim()
      ? verified.name.trim() : email.split('@')[0]).slice(0, 255);
    if (!email || email.length > 255 || !email.includes('@')) {
      return res.status(400).json({ status: 'error', message: 'Email akun tidak valid' });
    }

    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      // Serialisasi transaksi mapping untuk UID sama, termasuk saat request bersamaan.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`firebase:${verified.uid}`]);

      const mapped = await client.query(
        `SELECT u.id, u.nama, u.email, u.is_admin, u.member_status
           FROM external_user_identities e JOIN users u ON u.id=e.pulen_user_id
          WHERE e.provider='firebase' AND e.external_user_id=$1`, [verified.uid]
      );
      let pulenUser;
      if (mapped.rowCount > 0) {
        pulenUser = mapped.rows[0];
        if (pulenUser.email.toLowerCase() !== email) {
          await client.query('ROLLBACK');
          return res.status(409).json({status:'error', message:'Email Google berubah. Hubungi admin untuk pembaruan akun.'});
        }
      } else {
        // Jangan ambil alih akun PULEN lama yang memiliki email sama.
        const collision = await client.query('SELECT id FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1', [email]);
        if (collision.rowCount > 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({status:'error', message:'Email sudah terdaftar di PULEN. Perlu pengaitan oleh admin.'});
        }
        const randomPasswordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
        const created = await client.query(
          `INSERT INTO users (nama, email, password, is_admin, email_verified, member_status)
           VALUES ($1,$2,$3,false,true,'Aktif') RETURNING id,nama,email,is_admin,member_status`,
          [name, email, randomPasswordHash]
        );
        pulenUser = created.rows[0];
        await client.query(
          `INSERT INTO external_user_identities (provider,external_user_id,pulen_user_id)
           VALUES ('firebase',$1,$2)`, [verified.uid, pulenUser.id]
        );
      }
      if (pulenUser.is_admin === true || pulenUser.member_status !== 'Aktif') {
        await client.query('ROLLBACK');
        return res.status(403).json({status:'error',message:'Akun tidak diizinkan menggunakan PULEN'});
      }
      await client.query('COMMIT');
      // JWT PULEN (user.id PULEN), bukan token MyKopay/Firebase yang diteruskan.
      const token = jwt.sign({ id: pulenUser.id, scope: 'pulen-member' }, process.env.JWT_SECRET, {
        expiresIn: '15m', issuer: 'pulen-api', audience: 'pulen-mobile',
      });
      return res.json({status:'success', token, expires_in:900,
        user:{id:pulenUser.id,nama:pulenUser.nama,email:pulenUser.email}});
    } catch (e) {
      if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
      console.error('[PULEN auth] Pertukaran sesi gagal:', e && e.code ? e.code : 'internal_error');
      if (e && e.code === '23505') return res.status(409).json({status:'error',message:'Konflik data email/identitas. Hubungi admin.'});
      if (e && e.code === '42P01') return res.status(503).json({status:'error',message:'Migrasi tabel identitas PULEN belum dijalankan'});
      return res.status(500).json({status:'error',message:'Gagal menyiapkan sesi PULEN'});
    } finally {
      if (client) client.release();
    }
  });
  return router;
};
