'use strict';
// Shared, idempotent, atomic loan close for PULEN API routes.
// Lock order: books -> loans -> offers/queue. Every status and stock change commits together.
const { offerNextInTransaction } = require('./pulen_queue_notifications');

function validId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

async function closeLoan({ pool, loanId, userId = null, newStatus = 'dikembalikan', requireExpired = false }) {
  const id = validId(loanId);
  const owner = userId === null ? null : validId(userId);
  if (!id || (userId !== null && !owner)) return {changed: false, reason: 'invalid'};
  if (!['dikembalikan', 'berakhir_otomatis'].includes(newStatus)) throw new Error('INVALID_LOAN_STATUS');
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // The metadata lookup is not locked; the loan's book_id should be immutable.
    // A book row lock is acquired before the loan UPDATE to avoid racing with OTP claims.
    const lookup = await client.query('SELECT book_id FROM public.loans WHERE id = $1', [id]);
    if (!lookup.rows.length) {
      await client.query('ROLLBACK');
      return {changed: false, reason: 'not_found'};
    }
    const bookId = Number(lookup.rows[0].book_id);
    const book = await client.query('SELECT id FROM public.books WHERE id = $1 FOR UPDATE', [bookId]);
    if (!book.rows.length) throw new Error('BOOK_NOT_FOUND');
    const changed = await client.query(`
      UPDATE public.loans SET status = $1, tanggal_dikembalikan = CURRENT_TIMESTAMP
      WHERE id = $2 AND book_id = $3 AND status = 'aktif'
        AND ($4::integer IS NULL OR user_id = $4)
        AND ($5::boolean = false OR tanggal_kembali < NOW())
      RETURNING id, book_id, user_id, status, tanggal_dikembalikan
    `, [newStatus, id, bookId, owner, requireExpired]);
    if (!changed.rows.length) {
      await client.query('ROLLBACK');
      return {changed: false, reason: 'not_active_or_not_owner'};
    }
    await client.query('UPDATE public.books SET stok = COALESCE(stok, 0) + 1 WHERE id = $1', [bookId]);
    if (process.env.PULEN_AUTO_QUEUE_ENABLED === 'true') {
      await offerNextInTransaction(client, bookId);
    }
    await client.query('COMMIT');
    return {changed: true, loan: changed.rows[0]};
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    if (client) client.release();
  }
}

module.exports = { closeLoan };
