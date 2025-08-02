const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


const rooms = {}; // { roomId: { players: [] } }

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  let currentRoom = null;

  socket.on('createRoom', () => {
    const roomId = generateRoomId();
    rooms[roomId] = { players: [socket.id] };
    currentRoom = roomId;
    socket.join(roomId);
    socket.emit('roomCreated', roomId);
    io.to(roomId).emit('roomUpdate', rooms[roomId].players);
  });

  socket.on('joinRoom', (roomId) => {
    if (!rooms[roomId]) {
      socket.emit('errorMessage', 'Room does not exist!');
      return;
    }
    rooms[roomId].players.push(socket.id);
    currentRoom = roomId;
    socket.join(roomId);
    io.to(roomId).emit('roomUpdate', rooms[roomId].players);
  });

  socket.on('leaveRoom', (roomId) => {
    leaveRoom(socket, roomId);
    currentRoom = null;
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    if (currentRoom) {
      leaveRoom(socket, currentRoom);
    }
  });

  function leaveRoom(socket, roomId) {
    if (!rooms[roomId]) return;

    // Remove player
    rooms[roomId].players = rooms[roomId].players.filter(id => id !== socket.id);
    socket.leave(roomId);

    // If empty, delete room
    if (rooms[roomId].players.length === 0) {
      delete rooms[roomId];
      console.log(`Room ${roomId} deleted (empty).`);
    } else {
      io.to(roomId).emit('roomUpdate', rooms[roomId].players);
    }
  }
});

server.listen(3000, () => {
  console.log('Server running on port 3000');
});
