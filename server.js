import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';

const app = express();
app.use(express.json());
app.use(cors({ origin: true }));

// serve your frontend (put index.html, images/ inside ./public)
app.use(express.static('public'));

// MySQL pool
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10
});

// GET /api/products → products with variants (for grid/PDP)
app.get('/api/products', async (_req, res) => {
  try {
    const sql = `
      SELECT p.id AS pid, p.sku AS psku, p.name AS pname, p.description AS pdesc,
             COALESCE(v.image_url, p.image_url) AS img,
             v.id AS vid, v.label, v.grams, v.price, v.compare_at_price
      FROM products p
      JOIN product_variants v ON v.product_id = p.id
      WHERE p.status = 'active'
      ORDER BY p.id, v.grams
    `;
    const [rows] = await pool.query(sql);

    // group by product
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.pid)) {
        map.set(r.pid, {
          id: r.pid, sku: r.psku, name: r.pname,
          description: r.pdesc, image_url: r.img, variants: []
        });
      }
      map.get(r.pid).variants.push({
        id: r.vid,
        label: r.label,
        grams: r.grams,
        price: Number(r.price),
        compare: r.compare_at_price == null ? null : Number(r.compare_at_price),
        image: r.img
      });
    }
    res.json([...map.values()]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error: 'Failed to load products' });
  }
});

// POST /api/newsletter  {email}
app.post('/api/newsletter', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return res.status(400).json({ ok:false, error:'Invalid email' });
  try {
    await pool.query(
      'INSERT IGNORE INTO newsletter_subscribers (email) VALUES (?)',
      [email]
    );
    res.json({ ok:true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error:'Failed to subscribe' });
  }
});

// POST /api/checkout  {email, phone?, items:[{productSku,grams,qty}|{variantId,qty}], couponCode?}
app.post('/api/checkout', async (req, res) => {
  const { email = '', phone = '', items = [], couponCode = '', sessionId = '' } = req.body || {};
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ ok:false, error:'Cart is empty' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // find/create user (by email) – optional
    let userId = null;
    if (email) {
      const [u] = await conn.query('SELECT id FROM users WHERE email=?', [email]);
      if (u.length) userId = u[0].id;
      else {
        const [ins] = await conn.query(
          'INSERT INTO users (first_name,last_name,email,phone,password_hash) VALUES ("","",?,?, "")',
          [email, phone]
        );
        userId = ins.insertId;
      }
    }

    // resolve variants & prices from DB
    const resolved = [];
    let subtotal = 0;

    for (const it of items) {
      let row;
      if (it.variantId) {
        const [r] = await conn.query('SELECT id, price FROM product_variants WHERE id=?', [it.variantId]);
        row = r[0];
      } else {
        const [r] = await conn.query(
          `SELECT v.id, v.price
           FROM product_variants v
           JOIN products p ON p.id=v.product_id
           WHERE p.sku=? AND v.grams=? LIMIT 1`,
          [it.productSku, Number(it.grams)]
        );
        row = r[0];
      }
      if (!row) throw new Error('Variant not found');

      const qty = Math.max(1, Number(it.qty || 1));
      const unit = Number(row.price);
      subtotal += qty * unit;
      resolved.push({ variantId: row.id, qty, unit });
    }

    // coupon
    let discount = 0;
    if (couponCode) {
      const [c] = await conn.query(
        `SELECT discount_type, value, min_subtotal, is_active,
                (expires_at IS NULL OR expires_at > NOW()) AS valid
         FROM coupons WHERE code=?`, [couponCode]
      );
      if (c[0] && c[0].is_active && c[0].valid && subtotal >= Number(c[0].min_subtotal)) {
        discount = c[0].discount_type === 'percent'
          ? Math.round(subtotal * (Number(c[0].value)/100) * 100) / 100
          : Number(c[0].value);
        discount = Math.min(discount, subtotal);
      }
    }
    const total = Math.max(0, subtotal - discount);

    // create order + items
    const [o] = await conn.query(
      'INSERT INTO orders (user_id, session_id, total_amount, status, payment_reference) VALUES (?,?,?,?,NULL)',
      [userId, sessionId, total, 'created']
    );
    const orderId = o.insertId;

    for (const r of resolved) {
      await conn.query(
        'INSERT INTO order_items (order_id, product_variant_id, quantity, unit_price) VALUES (?,?,?,?)',
        [orderId, r.variantId, r.qty, r.unit]
      );
    }

    await conn.commit();
    res.json({ ok:true, orderId, subtotal, discount, total });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ ok:false, error: e.message });
  } finally {
    conn.release();
  }
});

const port = process.env.PORT || 5500;
app.listen(port, () => {
  console.log(`Yo Nutri API running on http://localhost:${port}`);
});
