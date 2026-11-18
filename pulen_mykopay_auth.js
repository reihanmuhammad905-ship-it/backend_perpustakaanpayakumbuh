
const express = require('express');
const crypto = require('crypto');

module.exports = function createMyKopayRouter({
  pool,
  jwt,
  bcrypt,
  generateMemberId,
}) {
  const router = express.Router();

  async function requestMyKopay(url, token) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });

      const data = await response.json().catch(() => null);

      return {
        ok: response.ok,
        status: response.status,
        data,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  router.post('/mykopay', async (req, res) => {
    const header = req.headers.authorization || '';
    const token = header.match(/^Bearer\s+(.+)$/i)?.[1]
      || req.body?.mykopay_token;

    if (!token || typeof token !== 'string') {
      return res.status(401).json({
        status: 'error',
        message: 'Token MyKopay diperlukan',
      });
    }

    const verifyUrl = process.env.MYKOPAY_VERIFY_URL;
    const profileUrl = process.env.MYKOPAY_PROFILE_STATUS_URL;

    if (!verifyUrl || !profileUrl) {
      return res.status(503).json({
        status: 'error',
        message: 'Konfigurasi integrasi belum lengkap',
      });
    }

    let identity;
    let biodata;

    try {
      const verified = await requestMyKopay(verifyUrl, token);

      if (!verified.ok || verified.data?.status !== 'success') {
        return res.status(
          verified.status === 403 ? 403 : 401
        ).json({
          status: 'error',
          message: 'Sesi MyKopay tidak valid',
        });
      }

      identity = verified.data.user;

      const profile = await requestMyKopay(profileUrl, token);

      if (!profile.ok || profile.data?.status !== true) {
        return res.status(502).json({
          status: 'error',
          message: 'Gagal memeriksa biodata MyKopay',
        });
      }

      biodata = profile.data.data || {};
    } catch (error) {
      console.error('[MYKOPAY] Verification failed:', error.message);
      return res.status(502).json({
        status: 'error',
        message: 'Tidak dapat menghubungi API MyKopay',
      });
    }

    const accountType = String(identity?.account_type || '');
    const accountId = String(identity?.account_id || '');
    const email = String(identity?.email || '').trim().toLowerCase();
    const name = String(identity?.name || '').trim();

    if (
      !['mykopay', 'asn'].includes(accountType) ||
      !accountId ||
      !email ||
      !name
    ) {
      return res.status(422).json({
        status: 'error',
        message: 'Identitas MyKopay belum mencukupi',
      });
    }

    if (
      accountType === 'mykopay' &&
      [0, 3].includes(Number(identity.status_user))
    ) {
      return res.status(403).json({
        status: 'error',
        message: 'Status akun MyKopay tidak diizinkan',
      });
    }

    const requiredText = ['nm_depan', 'tmp_lahir', 'tgl_lahir'];
    const requiredIds = [
      'id_pekerjaan',
      'id_prov',
      'id_kota',
      'id_kec',
      'id_kel',
    ];

    const missing = [
      ...requiredText.filter(
        field => !String(biodata[field] ?? '').trim()
      ),
      ...requiredIds.filter(
        field => !(Number(biodata[field]) > 0)
      ),
    ];

    if (missing.length) {
      return res.status(409).json({
        status: 'error',
        code: 'PROFILE_INCOMPLETE',
        message: 'Silakan lengkapi biodata terlebih dahulu',
        missing_fields: missing,
      });
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Serialisasi proses untuk identitas yang sama.
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`${accountType}:${accountId}`]
      );

      let result = await client.query(
        `SELECT *
         FROM public.users
         WHERE mykopay_account_type = $1
           AND mykopay_account_id = $2
         FOR UPDATE`,
        [accountType, accountId]
      );

      let user = result.rows[0];

      if (!user) {
        // Jangan mengklaim akun lama hanya berdasarkan email.
        const existingEmail = await client.query(
          `SELECT id FROM public.users
           WHERE LOWER(email) = $1
           LIMIT 1`,
          [email]
        );

        if (existingEmail.rows.length) {
          await client.query('ROLLBACK');

          return res.status(409).json({
            status: 'error',
            code: 'ACCOUNT_LINK_REQUIRED',
            message: 'Akun PULEN lama perlu dihubungkan terlebih dahulu',
          });
        }

        const memberId = await generateMemberId(client);
        const password = await bcrypt.hash(
          crypto.randomBytes(32).toString('hex'),
          10
        );

        result = await client.query(
          `INSERT INTO public.users (
            nama, email, password, is_admin,
            member_id, mykopay_account_type,
            mykopay_account_id, email_verified
          )
          VALUES ($1, $2, $3, false, $4, $5, $6, false)
          RETURNING *`,
          [
            name, email, password, memberId,
            accountType, accountId,
          ]
        );

        user = result.rows[0];
      } else {
        if (user.is_admin || user.member_status === 'Diblokir') {
          await client.query('ROLLBACK');

          return res.status(403).json({
            status: 'error',
            message: 'Akun PULEN tidak diizinkan',
          });
        }

        const memberId = user.member_id ||
          await generateMemberId(client);

        result = await client.query(
          `UPDATE public.users
           SET nama = $1,
               email = $2,
               member_id = $3,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $4
           RETURNING *`,
          [name, email, memberId, user.id]
        );

        user = result.rows[0];
      }

      await client.query(
        `INSERT INTO public.pulen_member_biodata (
          pulen_user_id, nm_depan, nm_belakang,
          tmp_lahir, tgl_lahir, id_pekerjaan,
          id_prov, id_kota, id_kec, id_kel,
          synced_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
        ON CONFLICT (pulen_user_id)
        DO UPDATE SET
          nm_depan = EXCLUDED.nm_depan,
          nm_belakang = EXCLUDED.nm_belakang,
          tmp_lahir = EXCLUDED.tmp_lahir,
          tgl_lahir = EXCLUDED.tgl_lahir,
          id_pekerjaan = EXCLUDED.id_pekerjaan,
          id_prov = EXCLUDED.id_prov,
          id_kota = EXCLUDED.id_kota,
          id_kec = EXCLUDED.id_kec,
          id_kel = EXCLUDED.id_kel,
          synced_at = NOW()`,
        [
          user.id,
          biodata.nm_depan,
          biodata.nm_belakang || null,
          biodata.tmp_lahir,
          biodata.tgl_lahir,
          biodata.id_pekerjaan,
          biodata.id_prov,
          biodata.id_kota,
          biodata.id_kec,
          biodata.id_kel,
        ]
      );

      await client.query('COMMIT');

      const pulenToken = jwt.sign(
        { id: user.id, email: user.email, role: 'anggota' },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );

      return res.json({
        status: 'success',
        token: pulenToken,
        user: {
          id: user.id,
          nama: user.nama,
          email: user.email,
          member_id: user.member_id,
          role: 'anggota',
        },
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[MYKOPAY SYNC]', error.message);

      return res.status(error.code === '23505' ? 409 : 500).json({
        status: 'error',
        message: 'Sinkronisasi akun PULEN belum berhasil',
      });
    } finally {
      client.release();
    }
  });

  return router;
};
