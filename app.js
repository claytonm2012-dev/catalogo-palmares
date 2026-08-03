const express = require('express');
const session = require('express-session');
const path = require('path');
const database = require('./db/database');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'palmares-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(async (req, res, next) => {
  try {
    await database.ready;
    next();
  } catch (err) {
    next(err);
  }
});

app.use('/', publicRoutes);
app.use('/admin', adminRoutes);

app.use((req, res) => {
  res.status(404).render('public/404', { title: 'Página não encontrada' });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (err && err.code === '23505') {
    return res.status(409).send('Já existe um registro com esse valor único (SKU/slug/e-mail duplicado).');
  }
  res.status(500).send('Erro interno do servidor.');
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
  });
}

module.exports = app;
