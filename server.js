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

const CARDS = ['Duke', 'Assassin', 'Captain', 'Ambassador', 'Contessa'];
const DECK = [];
CARDS.forEach(card => {
  // Add 3 of each card to the deck
  for (let i = 0; i < 3; i++) {
    DECK.push(card);
  }
});

const rooms = {}; // { roomId: { players: [] } }

// Fisher-Yates array shuffling algorithm
function shuffle(array) {
  let currentIndex = array.length,  randomIndex;
  // While there remain elements to shuffle.
  while (currentIndex > 0) {
    // Pick a remaining element.
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;
    // And swap it with the current element.
    [array[currentIndex], array[randomIndex]] = [
      array[randomIndex], array[currentIndex]];
  }
  return array;
}

function generateRoomId() {
    return uuidv4().substring(0,6).toUpperCase(); // Generate a short room ID
}

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    let currentRoom = null;

    socket.on('startGame', (roomId) => {
        // 1. --- VALIDATION ---
        const room = rooms[roomId];
        if (!room) return; // Room doesn't exist
        if (room.hostId !== socket.id) return; // Only the host can start
        if (room.players.length < 2) return; // Need at least 2 players
        if (room.gameState) return; // Game has already started

        console.log('Starting game in room ${roomId}');

        // 2. --- INITIALIZE GAME STATE ---
        const shuffledDeck = shuffle([...DECK]); // Create a shuffled copy of the deck

        const initialPlayerStates = room.players.map(player => ({
            id: player.id,
            name: player.name,
            coins: 2,
            cards: [shuffledDeck.pop(), shuffledDeck.pop()], // Deal 2 cards to each player
            isAlive: true,
            revealedCards: []
        }));

        const startingPlayerIndex = Math.floor(Math.random() * room.players.length);

        // This is the master game state object
        const gameState = {
            players: initialPlayerStates,
            deck: shuffledDeck,
            currentPlayerIndex: startingPlayerIndex,
            actionLog: [`Game started. It is ${initialPlayerStates[startingPlayerIndex].name}'s turn.`]
        };

        room.gameState = gameState;
        // 3. --- BROADCAST TO PLAYERS ---
        io.to(roomId).emit('gameStarted', gameState);
    });

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
