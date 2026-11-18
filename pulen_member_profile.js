'use strict';

const express = require('express');

function asText(value, max, required) {
  if (value == null) return required ? null : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/\s+/g, ' ');
  if ((required && !cleaned) || cleaned.length > max) return null;
  return cleaned || null;
}

function validBirthDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value) return false;
  const now = new Date();
  return d.getTime() < now.getTime() && d.getUTCFullYear() >= 1900;
}

const COLS = 'first_name, last_name, birth_place, birth_date::text AS birth_date, address, occupation, rt, rw, province, city, district, village, completed_at, source';
function output(row, defaultName) {
  if (!row) return { completed: false, data: { default_name: defaultName || '' } };
  const data = {};
  for (const field of ['first_name','last_name','birth_place','birth_date','address','occupation','rt','rw','province','city','district','village','completed_at','source']) {
    const value = row[field];
    data[field] = field === 'birth_date' && value instanceof Date ? value.toISOString().slice(0, 10) : value;
  }
  return { completed: Boolean(row.completed_at && row.first_name && row.birth_place && row.birth_date && row.address && row.occupation), data };
}

module.exports = function createPulenMemberProfileRouter({ pool, authenticateToken }) {
  const router = express.Router();
  router.use(authenticateToken);
  router.use((req, res, next) => {
    const id = Number(req.user?.id);
    // Hanya JWT anggota PULEN hasil pertukaran identitas; tidak menerima ID dari request body.
    if (!Number.isSafeInteger(id) || id <= 0 || req.user?.scope !== 'pulen-member') {
      return res.status(403).json({ status: 'error', message: 'Sesi anggota PULEN tidak sah' });
    }
    next();
  });

  router.get('/me', async (req, res) => {
    try {
      const user = await pool.query('SELECT nama FROM public.users WHERE id = $1', [req.user.id]);
      if (!user.rowCount) return res.status(404).json({ status:'error', message:'Akun PULEN tidak ditemukan' });
      const result = await pool.query(`SELECT ${COLS} FROM public.pulen_member_profiles WHERE pulen_user_id = $1`, [req.user.id]);
      res.json({ status: 'success', ...output(result.rows[0], user.rows[0].nama) });
    } catch (e) {
      console.error('[PULEN PROFILE] GET failed:', e.code || e.name);
      res.status(500).json({ status:'error', message:'Gagal membaca profil PULEN' });
    }
  });

  router.put('/me', async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const firstName = asText(body.first_name, 100, true);
    const lastName = asText(body.last_name, 100, false);
    const birthPlace = asText(body.birth_place, 120, true);
    const birthDate = body.birth_date;
    const address = asText(body.address, 500, true);
    const occupation = asText(body.occupation, 100, true);
    // Data tambahan tetap boleh disimpan, tetapi tidak menentukan kelengkapan profil.
    // Jika diisi, tipenya dan format RT/RW tetap divalidasi.
    const optionalFields = [
      ['last_name', 100], ['rt', 3], ['rw', 3],
      ['province', 100], ['city', 100], ['district', 100], ['village', 100],
    ];
    for (const [key, max] of optionalFields) {
      const value = body[key];
      if (value != null && (typeof value !== 'string' || value.trim().length > max)) {
        return res.status(422).json({status: 'error', message: `Format ${key} tidak valid`});
      }
    }
    const rt = asText(body.rt, 3, false);
    const rw = asText(body.rw, 3, false);
    const province = asText(body.province, 100, false);
    const city = asText(body.city, 100, false);
    const district = asText(body.district, 100, false);
    const village = asText(body.village, 100, false);
    if (!firstName || !birthPlace || !validBirthDate(birthDate) || !address || !occupation ||
        (rt && !/^\d{1,3}$/.test(rt)) || (rw && !/^\d{1,3}$/.test(rw))) {
      return res.status(422).json({
        status: 'error',
        message: 'Nama depan, tempat lahir, tanggal lahir, alamat tempat tinggal, dan pekerjaan wajib diisi.',
      });
    }
    try {
      const user = await pool.query('SELECT id FROM public.users WHERE id = $1', [req.user.id]);
      if (!user.rowCount) return res.status(404).json({ status:'error', message:'Akun PULEN tidak ditemukan' });
      const args = [req.user.id,firstName,lastName,birthPlace,birthDate,address,occupation,rt,rw,province,city,district,village];
      const result = await pool.query(`
        INSERT INTO public.pulen_member_profiles
          (pulen_user_id, first_name, last_name, birth_place, birth_date, address, occupation, rt, rw, province, city, district, village)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (pulen_user_id) DO UPDATE SET
          first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name,
          birth_place=EXCLUDED.birth_place, birth_date=EXCLUDED.birth_date,
          address=EXCLUDED.address, occupation=EXCLUDED.occupation, rt=EXCLUDED.rt, rw=EXCLUDED.rw,
          province=EXCLUDED.province, city=EXCLUDED.city,
          district=EXCLUDED.district, village=EXCLUDED.village,
          updated_at=now()
        RETURNING ${COLS}`, args);
      res.json({ status: 'success', message: 'Data diri berhasil disimpan', ...output(result.rows[0]) });
    } catch (e) {
      console.error('[PULEN PROFILE] PUT failed:', e.code || e.name);
      res.status(500).json({ status:'error', message:'Gagal menyimpan profil PULEN' });
    }
  });
  return router;
};
