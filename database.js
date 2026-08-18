const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_FILE = path.join(__dirname, 'users.json');

// Garantir que o arquivo exista
function initDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2), 'utf-8');
  }
}

function loadUsers() {
  initDB();
  try {
    const data = fs.readFileSync(DB_FILE, 'utf-8');
    return JSON.parse(data || '[]');
  } catch (err) {
    console.error('[DB Error] Falha ao carregar usuários:', err);
    return [];
  }
}

function saveUsers(users) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2), 'utf-8');
  } catch (err) {
    console.error('[DB Error] Falha ao salvar usuários:', err);
  }
}

// 1. Cadastrar Usuário
function registerUser({ name, email, password }) {
  const users = loadUsers();
  const cleanEmail = email.trim().toLowerCase();

  // Verificar se o e-mail já existe
  const existingUser = users.find(u => u.email === cleanEmail);
  if (existingUser) {
    throw new Error('E-mail já cadastrado no sistema.');
  }

  // Criptografar a senha com bcrypt
  const salt = bcrypt.genSaltSync(10);
  const passwordHash = bcrypt.hashSync(password, salt);

  const newUser = {
    id: 'usr_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    name: name.trim(),
    email: cleanEmail,
    passwordHash,
    createdAt: new Date().toISOString()
  };

  users.push(newUser);
  saveUsers(users);

  // Retornar usuário sem a hash da senha
  const { passwordHash: _, ...userWithoutPassword } = newUser;
  return userWithoutPassword;
}

// 2. Autenticar Usuário
function authenticateUser({ email, password }) {
  const users = loadUsers();
  const cleanEmail = email.trim().toLowerCase();

  const user = users.find(u => u.email === cleanEmail);
  if (!user) {
    return null;
  }

  // Comparar senha digitada com a hash salva
  const isMatch = bcrypt.compareSync(password, user.passwordHash);
  if (!isMatch) {
    return null;
  }

  const { passwordHash: _, ...userWithoutPassword } = user;
  return userWithoutPassword;
}

// 3. Buscar Usuário por ID
function getUserById(id) {
  const users = loadUsers();
  const user = users.find(u => u.id === id);
  if (!user) return null;

  const { passwordHash: _, ...userWithoutPassword } = user;
  return userWithoutPassword;
}

module.exports = {
  registerUser,
  authenticateUser,
  getUserById
};
