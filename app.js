const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fs = require('fs');
const db = require('./db');
const app = express();
const PORT = 3000;

if (!fs.existsSync('public/uploads')) {
  fs.mkdirSync('public/uploads', { recursive: true });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: 'public/uploads/',
    filename: (req, file, cb) => {
      cb(null, Date.now() + '-' + file.originalname);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, file.mimetype.startsWith('image/'));
  }
});

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
  secret: 'pos-app-secret-key',
  resave: false,
  saveUninitialized: false
}));

app.use((req, res, next) => {
  res.locals.fullName = req.session.fullName;
  res.locals.role = req.session.role;
  res.locals.currentPath = req.path;
  res.locals.flash = req.session.flash;
  req.session.flash = null;
  next();
});

function setFlash(req, message) {
  req.session.flash = message;
}

function requireLogin(req, res, next) {
  if (!req.session.userId) {
    res.redirect('/login');
    return;
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.session.role !== 'admin') {
    res.status(403).render('error', { message: 'This page is limited to admin accounts.' });
    return;
  }
  next();
}

function formatDateKey(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function logAudit(userId, action, details) {
  try {
    await db.query(
      'INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)',
      [userId, action, details]
    );
  } catch (err) {
    console.error('Audit log error:', err);
  }
}

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const [rows] = await db.query('SELECT * FROM users WHERE username = ?', [username]);
    const user = rows[0];

    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      await logAudit(null, 'login_failed', `Failed login attempt for username "${username}"`);
      res.render('login', { error: 'Incorrect username or password' });
      return;
    }

    req.session.userId = user.user_id;
    req.session.fullName = user.full_name;
    req.session.role = user.role;
    await logAudit(user.user_id, 'login', `${user.full_name} logged in`);
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error logging in');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

app.get('/', requireLogin, async (req, res) => {
  try {
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

    const [productRows] = await db.query('SELECT COUNT(*) AS count FROM products');
    const [stockValueRows] = await db.query('SELECT COALESCE(SUM(unit_price * quantity_in_stock), 0) AS total FROM products');
    const [salesTodayRows] = await db.query('SELECT COALESCE(SUM(total_amount), 0) AS total FROM sales WHERE DATE(sale_date) = CURDATE()');
    const [lowStockItems] = await db.query('SELECT * FROM products WHERE quantity_in_stock <= reorder_level ORDER BY quantity_in_stock ASC');

        const [recentSales] = await db.query(
      `SELECT s.sale_id, s.sale_date, s.total_amount, COUNT(si.sale_item_id) AS item_count, MIN(p.name) AS first_product_name
       FROM sales s
       JOIN sale_items si ON si.sale_id = s.sale_id
       JOIN products p ON p.product_id = si.product_id
       GROUP BY s.sale_id, s.sale_date, s.total_amount
       ORDER BY s.sale_date DESC
       LIMIT 5`
    );

    const [salesByDay] = await db.query(
      `SELECT DATE_FORMAT(sale_date, '%Y-%m-%d') AS day, SUM(total_amount) AS total
       FROM sales
       WHERE sale_date >= CURDATE() - INTERVAL 6 DAY
       GROUP BY DATE_FORMAT(sale_date, '%Y-%m-%d')`
    );

    const salesMap = {};
    salesByDay.forEach(row => {
      salesMap[row.day] = parseFloat(row.total);
    });

    const chartLabels = [];
    const chartValues = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      chartLabels.push(d.toLocaleDateString('en-US', { weekday: 'short' }));
      chartValues.push(salesMap[formatDateKey(d)] || 0);
    }

    res.render('dashboard', {
      greeting,
      productCount: productRows[0].count,
      stockValue: stockValueRows[0].total,
      salesToday: salesTodayRows[0].total,
      lowStockItems,
      recentSales,
      chartLabels,
      chartValues
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading dashboard');
  }
});

app.get('/products', requireLogin, async (req, res) => {
  try {
    const search = req.query.search || '';
    const category = req.query.category || '';

    let query = 'SELECT * FROM products WHERE 1=1';
    const params = [];

    if (search) {
      query += ' AND name LIKE ?';
      params.push(`%${search}%`);
    }
    if (category) {
      query += ' AND category = ?';
      params.push(category);
    }

    const [products] = await db.query(query, params);
    const [categoryRows] = await db.query(
      "SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category != '' ORDER BY category"
    );

    res.render('products', {
      products,
      search,
      category,
      categories: categoryRows.map(r => r.category)
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error fetching products');
  }
});

app.get('/products/new', requireLogin, requireAdmin, (req, res) => {
  res.render('add-product');
});

app.post('/products', requireLogin, requireAdmin, upload.single('photo'), async (req, res) => {
  try {
    const { name, sku, category, unit_price, quantity_in_stock, reorder_level } = req.body;
    const photoFilename = req.file ? req.file.filename : null;
    await db.query(
      'INSERT INTO products (name, sku, category, unit_price, quantity_in_stock, reorder_level, photo_filename) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [name, sku || null, category, unit_price, quantity_in_stock, reorder_level || 5, photoFilename]
    );
    await logAudit(req.session.userId, 'product_created', `Added product "${name}"`);
    setFlash(req, `"${name}" was added.`);
    res.redirect('/products');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(400).render('error', { message: 'That SKU is already used by another product. Leave it blank or choose a different one.' });
      return;
    }
    console.error(err);
    res.status(500).send('Error adding product');
  }
});

app.get('/products/:id/edit', requireLogin, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM products WHERE product_id = ?', [req.params.id]);
    const product = rows[0];

    if (!product) {
      res.status(404).send('Product not found');
      return;
    }

    res.render('edit-product', { product });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading product');
  }
});

app.post('/products/:id', requireLogin, requireAdmin, upload.single('photo'), async (req, res) => {
  try {
    const { name, sku, category, unit_price, quantity_in_stock, reorder_level } = req.body;

    if (req.file) {
      await db.query(
        `UPDATE products
         SET name = ?, sku = ?, category = ?, unit_price = ?, quantity_in_stock = ?, reorder_level = ?, photo_filename = ?
         WHERE product_id = ?`,
        [name, sku || null, category, unit_price, quantity_in_stock, reorder_level || 5, req.file.filename, req.params.id]
      );
    } else {
      await db.query(
        `UPDATE products
         SET name = ?, sku = ?, category = ?, unit_price = ?, quantity_in_stock = ?, reorder_level = ?
         WHERE product_id = ?`,
        [name, sku || null, category, unit_price, quantity_in_stock, reorder_level || 5, req.params.id]
      );
    }

    await logAudit(req.session.userId, 'product_updated', `Updated product "${name}"`);
    setFlash(req, `"${name}" was updated.`);
    res.redirect('/products');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(400).render('error', { message: 'That SKU is already used by another product. Leave it blank or choose a different one.' });
      return;
    }
    console.error(err);
    res.status(500).send('Error updating product');
  }
});

app.post('/products/:id/delete', requireLogin, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT name FROM products WHERE product_id = ?', [req.params.id]);
    const productName = rows[0] ? rows[0].name : `#${req.params.id}`;

        await db.query('DELETE FROM products WHERE product_id = ?', [req.params.id]);
    await logAudit(req.session.userId, 'product_deleted', `Deleted product "${productName}"`);
    setFlash(req, `"${productName}" was deleted.`);
    res.redirect('/products');
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2' || err.code === 'ER_ROW_IS_REFERENCED') {
      res.status(400).render('error', { message: "This product can't be deleted because it has sales recorded against it." });
      return;
    }
    console.error(err);
    res.status(500).send('Error deleting product');
  }
});

app.get('/sales/new', requireLogin, async (req, res) => {
  try {
    const [products] = await db.query('SELECT * FROM products WHERE quantity_in_stock > 0');

    if (!req.session.cart) {
      req.session.cart = [];
    }

    const cartTotal = req.session.cart.reduce((sum, item) => sum + item.unit_price * item.quantity, 0);

    res.render('new-sale', { products, cart: req.session.cart, cartTotal });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading products');
  }
});

app.post('/sales/cart/add', requireLogin, async (req, res) => {
  try {
    const { product_id, quantity } = req.body;
    const qty = parseInt(quantity);

    const [rows] = await db.query('SELECT * FROM products WHERE product_id = ?', [product_id]);
    const product = rows[0];

    if (!req.session.cart) {
      req.session.cart = [];
    }

    const existing = req.session.cart.find(item => item.product_id == product_id);
    const alreadyInCart = existing ? existing.quantity : 0;

    if (!product || qty < 1 || (alreadyInCart + qty) > product.quantity_in_stock) {
      res.redirect('/sales/new');
      return;
    }

    if (existing) {
      existing.quantity += qty;
    } else {
      req.session.cart.push({
        product_id: product.product_id,
        name: product.name,
        unit_price: product.unit_price,
        quantity: qty
      });
    }

    res.redirect('/sales/new');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error adding to cart');
  }
});

app.post('/sales/cart/remove', requireLogin, (req, res) => {
  const { product_id } = req.body;
  if (req.session.cart) {
    req.session.cart = req.session.cart.filter(item => item.product_id != product_id);
  }
  res.redirect('/sales/new');
});

app.post('/sales/checkout', requireLogin, async (req, res) => {
  try {
    const cart = req.session.cart;
    const paymentMethod = req.body.payment_method || 'cash';

    if (!cart || cart.length === 0) {
      res.redirect('/sales/new');
      return;
    }

    for (const item of cart) {
      const [rows] = await db.query('SELECT quantity_in_stock FROM products WHERE product_id = ?', [item.product_id]);
      if (!rows[0] || rows[0].quantity_in_stock < item.quantity) {
        res.status(400).render('error', { message: `Not enough stock left for "${item.name}".` });
        return;
      }
    }

    const total = cart.reduce((sum, item) => sum + item.unit_price * item.quantity, 0);

        const [saleResult] = await db.query(
      'INSERT INTO sales (user_id, total_amount, payment_method) VALUES (?, ?, ?)',
      [req.session.userId, total, paymentMethod]
    );

    for (const item of cart) {
      const subtotal = item.unit_price * item.quantity;

      await db.query(
        'INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, subtotal) VALUES (?, ?, ?, ?, ?)',
        [saleResult.insertId, item.product_id, item.quantity, item.unit_price, subtotal]
      );

      await db.query(
        'UPDATE products SET quantity_in_stock = quantity_in_stock - ? WHERE product_id = ?',
        [item.quantity, item.product_id]
      );
    }

    await logAudit(req.session.userId, 'sale_recorded', `Sold ${cart.length} item type(s) for NLe ${total.toFixed(2)}`);

    req.session.cart = [];

    res.redirect(`/sales/${saleResult.insertId}/receipt`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error completing sale');
  }
});

app.get('/sales/:id/receipt', requireLogin, async (req, res) => {
  try {
        const [rows] = await db.query(
      `SELECT s.sale_id, s.sale_date, s.total_amount, s.payment_method,
              si.quantity, si.unit_price, si.subtotal,
              p.name AS product_name
       FROM sales s
       JOIN sale_items si ON si.sale_id = s.sale_id
       JOIN products p ON p.product_id = si.product_id
       WHERE s.sale_id = ?`,
      [req.params.id]
    );

    if (rows.length === 0) {
      res.status(404).send('Sale not found');
      return;
    }

    res.render('receipt', { sale: rows[0], items: rows });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading receipt');
  }
});

app.get('/reports', requireLogin, async (req, res) => {
  try {
    const today = new Date();
    const defaultFrom = new Date();
    defaultFrom.setDate(defaultFrom.getDate() - 29);

    const from = req.query.from || formatDateKey(defaultFrom);
    const to = req.query.to || formatDateKey(today);

    const [summaryRows] = await db.query(
      'SELECT COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS total FROM sales WHERE DATE(sale_date) BETWEEN ? AND ?',
      [from, to]
    );

    const [sales] = await db.query(
      `SELECT s.sale_id, s.sale_date, s.total_amount, p.name AS product_name, si.quantity
       FROM sales s
       JOIN sale_items si ON si.sale_id = s.sale_id
       JOIN products p ON p.product_id = si.product_id
       WHERE DATE(s.sale_date) BETWEEN ? AND ?
       ORDER BY s.sale_date DESC`,
      [from, to]
    );

    res.render('reports', {
      from,
      to,
      salesCount: summaryRows[0].count,
      salesTotal: summaryRows[0].total,
      sales
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading reports');
  }
});

app.get('/audit-log', requireLogin, requireAdmin, async (req, res) => {
  try {
    const [entries] = await db.query(
      `SELECT a.audit_id, a.action, a.details, a.created_at, u.full_name
       FROM audit_log a
       LEFT JOIN users u ON u.user_id = a.user_id
       ORDER BY a.created_at DESC
       LIMIT 100`
    );
    res.render('audit-log', { entries });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading audit log');
  }
});

app.get('/reports/export', requireLogin, async (req, res) => {
  try {
    const today = new Date();
    const defaultFrom = new Date();
    defaultFrom.setDate(defaultFrom.getDate() - 29);

    const from = req.query.from || formatDateKey(defaultFrom);
    const to = req.query.to || formatDateKey(today);

    const [sales] = await db.query(
      `SELECT s.sale_id, s.sale_date, s.total_amount, p.name AS product_name, si.quantity
       FROM sales s
       JOIN sale_items si ON si.sale_id = s.sale_id
       JOIN products p ON p.product_id = si.product_id
       WHERE DATE(s.sale_date) BETWEEN ? AND ?
       ORDER BY s.sale_date DESC`,
      [from, to]
    );

    let csv = 'Sale ID,Date,Product,Quantity,Amount\n';
    sales.forEach(sale => {
      const date = new Date(sale.sale_date).toLocaleString();
      csv += `${sale.sale_id},"${date}","${sale.product_name}",${sale.quantity},${sale.total_amount}\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="sales-report-${from}-to-${to}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error exporting report');
  }
});

app.get('/users', requireLogin, requireAdmin, async (req, res) => {
  try {
    const [users] = await db.query('SELECT user_id, full_name, username, role FROM users ORDER BY full_name');
    res.render('users', { users });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading users');
  }
});

app.get('/users/new', requireLogin, requireAdmin, (req, res) => {
  res.render('add-user');
});

app.post('/users', requireLogin, requireAdmin, async (req, res) => {
  try {
    const { full_name, username, password, role } = req.body;
    const passwordHash = bcrypt.hashSync(password, 10);
    await db.query(
      'INSERT INTO users (full_name, username, password_hash, role) VALUES (?, ?, ?, ?)',
      [full_name, username, passwordHash, role]
    );
        await logAudit(req.session.userId, 'user_created', `Created user "${username}" with role ${role}`);
    setFlash(req, `"${username}" was added.`);
    res.redirect('/users');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(400).render('error', { message: 'That username is already taken.' });
      return;
    }
    console.error(err);
    res.status(500).send('Error creating user');
  }
});

app.get('/users/:id/edit', requireLogin, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT user_id, full_name, username, role FROM users WHERE user_id = ?', [req.params.id]);
    const user = rows[0];

    if (!user) {
      res.status(404).render('error', { message: 'User not found.' });
      return;
    }

    res.render('edit-user', { user });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error loading user');
  }
});

app.post('/users/:id', requireLogin, requireAdmin, async (req, res) => {
  try {
    const { full_name, username, password, role } = req.body;

    if (password) {
      const passwordHash = bcrypt.hashSync(password, 10);
      await db.query(
        'UPDATE users SET full_name = ?, username = ?, password_hash = ?, role = ? WHERE user_id = ?',
        [full_name, username, passwordHash, role, req.params.id]
      );
    } else {
      await db.query(
        'UPDATE users SET full_name = ?, username = ?, role = ? WHERE user_id = ?',
        [full_name, username, role, req.params.id]
      );
    }

    await logAudit(req.session.userId, 'user_updated', `Updated user "${username}"`);
    setFlash(req, `"${username}" was updated.`);
    res.redirect('/users');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      res.status(400).render('error', { message: 'That username is already taken.' });
      return;
    }
    console.error(err);
    res.status(500).send('Error updating user');
  }
});

app.post('/users/:id/delete', requireLogin, requireAdmin, async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.session.userId) {
      res.status(400).render('error', { message: "You can't delete your own account while logged in as it." });
      return;
    }

    const [rows] = await db.query('SELECT username FROM users WHERE user_id = ?', [req.params.id]);
    const username = rows[0] ? rows[0].username : `#${req.params.id}`;

    await db.query('DELETE FROM users WHERE user_id = ?', [req.params.id]);
    await logAudit(req.session.userId, 'user_deleted', `Deleted user "${username}"`);
    setFlash(req, `"${username}" was removed.`);
    res.redirect('/users');
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2' || err.code === 'ER_ROW_IS_REFERENCED') {
      res.status(400).render('error', { message: "This user can't be deleted because they have sales recorded against them." });
      return;
    }
    console.error(err);
    res.status(500).send('Error deleting user');
  }
});

app.use((req, res) => {
  res.status(404).render('error', { message: "That page doesn't exist." });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { message: 'Something went wrong. Please try again.' });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});