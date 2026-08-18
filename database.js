const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_FILE = path.join(__dirname, 'users.json');

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

  const existingUser = users.find(u => u.email === cleanEmail);
  if (existingUser) {
    throw new Error('E-mail já cadastrado no sistema.');
  }

  const salt = bcrypt.genSaltSync(10);
  const passwordHash = bcrypt.hashSync(password, salt);

  const newUser = {
    id: 'usr_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    name: name.trim(),
    email: cleanEmail,
    passwordHash,
    friends: [], // Array de { friendId, status: 'accepted' | 'pending_sent' | 'pending_received' }
    createdAt: new Date().toISOString()
  };

  users.push(newUser);
  saveUsers(users);

  const { passwordHash: _, ...userWithoutPassword } = newUser;
  return userWithoutPassword;
}

// 2. Autenticar Usuário
function authenticateUser({ email, password }) {
  const users = loadUsers();
  const cleanEmail = email.trim().toLowerCase();

  const user = users.find(u => u.email === cleanEmail);
  if (!user) return null;

  const isMatch = bcrypt.compareSync(password, user.passwordHash);
  if (!isMatch) return null;

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

// 4. SISTEMA DE AMIZADES
function sendFriendRequest(userId, targetEmail) {
  const users = loadUsers();
  const cleanEmail = targetEmail.trim().toLowerCase();

  const user = users.find(u => u.id === userId);
  const targetUser = users.find(u => u.email === cleanEmail);

  if (!targetUser) throw new Error('Usuário não encontrado com este e-mail.');
  if (targetUser.id === userId) throw new Error('Você não pode adicionar a si mesmo.');

  if (!user.friends) user.friends = [];
  if (!targetUser.friends) targetUser.friends = [];

  const existing = user.friends.find(f => f.friendId === targetUser.id);
  if (existing) {
    if (existing.status === 'accepted') throw new Error('Este usuário já é seu amigo.');
    if (existing.status === 'pending_sent') throw new Error('Solicitação de amizade já enviada.');
    if (existing.status === 'pending_received') throw new Error('Este usuário já te enviou uma solicitação. Aceite-a na aba Amigos!');
  }

  user.friends.push({ friendId: targetUser.id, status: 'pending_sent' });
  targetUser.friends.push({ friendId: user.id, status: 'pending_received' });

  saveUsers(users);
  return { success: true, message: `Solicitação enviada para ${targetUser.name}!` };
}

function acceptFriendRequest(userId, friendId) {
  const users = loadUsers();

  const user = users.find(u => u.id === userId);
  const friend = users.find(u => u.id === friendId);

  if (!user || !friend) throw new Error('Usuário não encontrado.');

  const rel1 = user.friends ? user.friends.find(f => f.friendId === friendId) : null;
  const rel2 = friend.friends ? friend.friends.find(f => f.friendId === userId) : null;

  if (rel1) rel1.status = 'accepted';
  else user.friends.push({ friendId, status: 'accepted' });

  if (rel2) rel2.status = 'accepted';
  else friend.friends.push({ friendId: userId, status: 'accepted' });

  saveUsers(users);
  return { success: true, message: `Agora você e ${friend.name} são amigos!` };
}

function getFriendsList(userId) {
  const users = loadUsers();
  const user = users.find(u => u.id === userId);
  if (!user || !user.friends) return [];

  return user.friends.map(f => {
    const friendObj = users.find(u => u.id === f.friendId);
    if (!friendObj) return null;
    return {
      id: friendObj.id,
      name: friendObj.name,
      email: friendObj.email,
      status: f.status
    };
  }).filter(Boolean);
}

module.exports = {
  registerUser,
  authenticateUser,
  getUserById,
  sendFriendRequest,
  acceptFriendRequest,
  getFriendsList
};
