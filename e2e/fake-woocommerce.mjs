// A SMALL STATEFUL STAND-IN for WooCommerce, used only by the e2e run (WordPress/MySQL cannot run in the authoring sandbox).
// It implements just the REST v3 routes woo-mcp uses, with Basic-auth, plus two TEST-ONLY hooks that play the shopper:
//   POST /__test/checkout   = "a shopper adds a product to the cart and checks out with cash on delivery"
//   GET  /__test/storefront = "what a visitor sees on the shop page" (published products only)
// Anything proven through this file is SIMULATED, not proof that real WooCommerce behaves the same.
import http from 'node:http';
import express from '../gateway/node_modules/express/index.js';

export function startFakeWoo({ port, key, secret }) {
  const products = [{ id: 10, name: 'Starter Mug', status: 'publish', price: '299', regular_price: '299', stock_status: 'instock', permalink: 'http://shop.test/product/starter-mug/' }];
  const orders = []; let nextProduct = 11, nextOrder = 1001;
  const app = express(); app.use(express.json());
  const want = 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64');
  const nowLocal = () => new Date().toISOString().slice(0, 19);

  app.get('/__test/storefront', (req, res) => res.json(products.filter((p) => p.status === 'publish').map((p) => ({ name: p.name, price: p.price }))));
  app.post('/__test/checkout', (req, res) => {
    const p = products.find((x) => x.id === req.body.product_id && x.status === 'publish');
    if (!p) return res.status(404).json({ error: 'product not on the storefront' });
    const qty = req.body.quantity ?? 1;
    const o = { id: nextOrder++, number: String(nextOrder - 1), status: 'processing', total: (Number(p.price) * qty).toFixed(2), currency: 'INR', date_created: nowLocal(),
      payment_method: 'cod', payment_method_title: 'Cash on delivery', customer_id: 0,
      billing: { first_name: 'Test', last_name: 'Shopper', email: 'shopper@example.com', phone: '9000000000' },   // PII on purpose: woo-mcp must not leak it
      line_items: [{ product_id: p.id, name: p.name, quantity: qty, total: (Number(p.price) * qty).toFixed(2) }] };
    orders.push(o); res.status(201).json({ order: o.id });
  });

  app.use('/wp-json/wc/v3', (req, res) => {
    if (req.headers.authorization !== want) return res.status(401).json({ code: 'woocommerce_rest_cannot_view', message: 'Sorry, you cannot list resources.' });
    if (req.method === 'GET' && req.path === '/products') return res.json(products);
    if (req.method === 'POST' && req.path === '/products') {
      const b = req.body; const p = { id: nextProduct++, name: b.name, status: b.status ?? 'publish', price: b.regular_price, regular_price: b.regular_price, stock_status: 'instock', permalink: `http://shop.test/product/${nextProduct}/` };
      products.push(p); return res.status(201).json(p);
    }
    if (req.method === 'GET' && req.path === '/orders') {
      let list = [...orders].reverse(); if (req.query.after) list = list.filter((o) => o.date_created >= req.query.after);
      if (req.query.status && req.query.status !== 'any') list = list.filter((o) => o.status === req.query.status); return res.json(list);
    }
    const m = /^\/orders\/(\d+)$/.exec(req.path); const o = m && orders.find((x) => x.id === Number(m[1]));
    if (m && !o) return res.status(404).json({ code: 'woocommerce_rest_shop_order_invalid_id', message: 'Invalid ID.' });
    if (o && req.method === 'GET') return res.json(o);
    if (o && req.method === 'PUT') { o.status = req.body.status; return res.json(o); }
    res.status(404).json({ message: 'no route' });
  });
  const srv = http.createServer(app);
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r({ url: `http://127.0.0.1:${port}`, close: () => { srv.closeAllConnections(); srv.close(); } })));
}
