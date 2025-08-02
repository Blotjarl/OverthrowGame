const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const { v4: uuidv4 } = require('uuid');

const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


const rooms = {}; // { roomId: { players: [] } }

function generateRoomId() {
  return uuidv4().substring(0,6).toUpperCase(); // Generate a short room ID
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  let currentRoom = null;

  socket.on('createRoom', ({ username }) => {
    const roomId = generateRoomId();
    rooms[roomId] = {
        hostId: socket.id,
        players: [{ id: socket.id, name: username }]
    };
    currentRoom = roomId;
    socket.join(roomId);
    socket.emit('roomCreated', roomId);
    io.to(roomId).emit('roomUpdate', rooms[roomId]);
  });

  socket.on('joinRoom', ({ roomId, username }) => {
    if (!rooms[roomId]) {
      socket.emit('errorMessage', 'Room does not exist!');
      return;
    }
    rooms[roomId].players.push({ id: socket.id, name: username });
    currentRoom = roomId;
    socket.join(roomId);
    io.to(roomId).emit('roomUpdate', rooms[roomId]);
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
    rooms[roomId].players = rooms[roomId].players.filter(player => player.id !== socket.id);
    socket.leave(roomId);

    // If empty, delete room
    if (rooms[roomId].players.length === 0) {
      delete rooms[roomId];
      console.log(`Room ${roomId} deleted (empty).`);
    } else {
      io.to(roomId).emit('roomUpdate', rooms[roomId]);
    }
  }
});

server.listen(3000, () => {
  console.log('Server running on port 3000');
});
