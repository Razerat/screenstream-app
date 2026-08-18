const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const db = require('./database.js');

const JWT_SECRET = process.env.JWT_SECRET || 'screenstream_super_secret_key_2026';
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);

// Habilitar CORS completo no Express para suportar chamadas do Netlify e Localtunnel
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization', 'Bypass-Tunnel-Remainder', 'bypass-tunnel-reminder']
}));

// Fallback manual de cabeçalhos CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization, Bypass-Tunnel-Remainder, bypass-tunnel-reminder");
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// API DE AUTENTICAÇÃO (CORS HABILITADO)
// ============================================================================
app.post('/api/register', (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'A senha deve ter no mínimo 6 caracteres.' });
    }

    const user = db.registerUser({ name, email, password });
    const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({ message: 'Usuário cadastrado com sucesso!', user, token });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
    }

    const user = db.authenticateUser({ email, password });
    if (!user) {
      return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
    }

    const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    res.json({ message: 'Login realizado com sucesso!', user, token });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno ao realizar login.' });
  }
});

app.get('/api/me', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Não autenticado.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.getUserById(decoded.id);
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado.' });
    res.json({ user });
  } catch (err) {
    res.status(401).json({ error: 'Token inválido ou expirado.' });
  }
});

// ============================================================================
// SOCKET.IO REALTIME SIGNALING, CHAT & ONLINE USERS TRACKER
// ============================================================================
const rooms = new Map();

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function broadcastRoomUsers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const participants = [];

  if (room.presenterId) {
    participants.push({
      id: room.presenterId,
      name: room.presenterName,
      isPresenter: true,
      isBroadcasting: room.isBroadcasting
    });
  }

  for (const [viewerId, viewerName] of room.viewers.entries()) {
    participants.push({
      id: viewerId,
      name: viewerName,
      isPresenter: false,
      isBroadcasting: false
    });
  }

  io.to(roomId).emit('room-users-update', {
    roomId,
    presenterName: room.presenterName,
    isBroadcasting: room.isBroadcasting,
    totalOnline: participants.length,
    participants
  });
}

io.use((socket, next) => {
  const token = socket.handshake.auth.token || socket.handshake.headers.token;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.user = decoded;
    } catch (err) {
      console.warn('[Socket Auth Warning] Token inválido.');
    }
  }
  next();
});

io.on('connection', (socket) => {
  const userName = socket.user ? socket.user.name : `Visitante_${socket.id.substring(0, 4)}`;
  socket.userName = userName;

  console.log(`[Socket Connected] ID: ${socket.id} | Usuário: ${userName}`);

  socket.on('create-room', () => {
    for (const [id, room] of rooms.entries()) {
      if (room.presenterId === socket.id) {
        io.to(id).emit('presenter-left');
        rooms.delete(id);
      }
    }

    let roomId = generateRoomId();
    while (rooms.has(roomId)) {
      roomId = generateRoomId();
    }

    rooms.set(roomId, {
      presenterId: socket.id,
      presenterName: userName,
      viewers: new Map(),
      isBroadcasting: true,
      createdAt: new Date()
    });

    socket.join(roomId);
    socket.roomId = roomId;
    socket.isPresenter = true;

    console.log(`[Sala Criada] Code: ${roomId} | Presenter: ${userName}`);
    socket.emit('room-created', { roomId, presenterName: userName });
    broadcastRoomUsers(roomId);
  });

  socket.on('join-room', ({ roomId }) => {
    const cleanRoomId = roomId ? roomId.trim().toUpperCase() : '';
    const room = rooms.get(cleanRoomId);

    if (!room) {
      return socket.emit('room-error', { message: 'Sala não encontrada. Verifique o código digitado.' });
    }

    room.viewers.set(socket.id, userName);
    socket.join(cleanRoomId);
    socket.roomId = cleanRoomId;
    socket.isPresenter = false;

    console.log(`[Espectador Entrou] Room: ${cleanRoomId} | Viewer: ${userName}`);

    socket.emit('room-joined', { 
      roomId: cleanRoomId,
      presenterId: room.presenterId,
      presenterName: room.presenterName,
      isBroadcasting: room.isBroadcasting
    });

    io.to(room.presenterId).emit('viewer-joined', { 
      viewerId: socket.id,
      viewerName: userName,
      totalViewers: room.viewers.size
    });

    io.to(cleanRoomId).emit('chat-system-message', {
      text: `${userName} entrou na sala.`
    });

    broadcastRoomUsers(cleanRoomId);
  });

  socket.on('offer', ({ targetId, offer }) => {
    io.to(targetId).emit('offer', { senderId: socket.id, offer });
  });

  socket.on('answer', ({ targetId, answer }) => {
    io.to(targetId).emit('answer', { senderId: socket.id, answer });
  });

  socket.on('ice-candidate', ({ targetId, candidate }) => {
    if (targetId && candidate) {
      io.to(targetId).emit('ice-candidate', { senderId: socket.id, candidate });
    }
  });

  socket.on('send-chat-message', ({ messageText }) => {
    if (!socket.roomId) return;
    const text = messageText ? messageText.trim() : '';
    if (!text) return;

    const chatData = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      senderId: socket.id,
      senderName: userName,
      isPresenter: socket.isPresenter || false,
      text,
      time: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    };

    io.to(socket.roomId).emit('chat-message', chatData);
  });

  socket.on('stop-sharing', () => {
    if (socket.roomId && rooms.has(socket.roomId)) {
      const room = rooms.get(socket.roomId);
      if (room.presenterId === socket.id) {
        room.isBroadcasting = false;
        socket.to(socket.roomId).emit('presenter-left');
        broadcastRoomUsers(socket.roomId);
        rooms.delete(socket.roomId);
      }
    }
  });

  socket.on('disconnect', () => {
    if (socket.roomId && rooms.has(socket.roomId)) {
      const room = rooms.get(socket.roomId);

      if (socket.isPresenter || room.presenterId === socket.id) {
        socket.to(socket.roomId).emit('presenter-left');
        rooms.delete(socket.roomId);
      } else {
        room.viewers.delete(socket.id);
        io.to(room.presenterId).emit('viewer-left', {
          viewerId: socket.id,
          totalViewers: room.viewers.size
        });
        io.to(socket.roomId).emit('chat-system-message', {
          text: `${userName} saiu da sala.`
        });
        broadcastRoomUsers(socket.roomId);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(` Servidor ScreenStream (CORS Habilitado + Auth + Chat) ON!`);
  console.log(` Acesse localmente em: http://localhost:${PORT}`);
  console.log(`====================================================`);
});
