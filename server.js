const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let rooms = {}; // Track rooms and players

//Serve static files
app.use(express.static(__dirname + '/public'));

io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    // Create a room
    socket.on('createRoom', () => {
        const roomId = Math.random().toString(36).substr(2, 6).toUpperCase(); // e.g., "AB12CD"
        socket.join(roomId);

        if (!rooms[roomId]) rooms[roomId] = [];
        rooms[roomId].push(socket.id);

        console.log(`Room ${roomId} created by ${socket.id}`);
        socket.emit('roomCreated', roomId);
        io.to(roomId).emit('roomUpdate', rooms[roomId]);
    });

    // Join a room
    socket.on('joinRoom', (roomName) => {
        if (!rooms[roomName]) {
            socket.emit('errorMessage', 'Room does not exist.');
            return;
        }
        socket.join(roomName);
        rooms[roomName].push(socket.id);

        console.log(`Player ${socket.id} joined room ${roomName}`);
        io.to(roomName).emit('roomUpdate', rooms[roomName]);
    });

    // Handle disconnect
    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);

        for (const room in rooms) {
            // Remove player from room
            rooms[room] = rooms[room].filter(id => id !== socket.id);

            // 🔹 Automatically clean up empty rooms
            if (rooms[room].length === 0) {
                delete rooms[room];
                console.log(`Room ${room} deleted (empty)`);
            } else {
                // Update other players in that room
                io.to(room).emit('roomUpdate', rooms[room]);
            }
        }
    });
});

server.listen(3000, () => {
    console.log('Server running on port 3000');
});
