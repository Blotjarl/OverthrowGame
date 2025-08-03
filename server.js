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

    socket.on('revealCard', ({ roomId, cardName }) => {
        const room = rooms[roomId];
        if (!room || !room.gameState || room.gameState.phase !== 'reveal_card') return;

        let gameState = room.gameState;
        // Make sure the right person is revealing
        if (socket.id !== gameState.playerToReveal.id) return;

        const player = gameState.players.find(p => p.id === socket.id);
        const cardIndex = player.cards.indexOf(cardName);

        if (cardIndex > -1) {
            // Move the card from their hand to their revealed cards
            player.revealedCards.push(player.cards.splice(cardIndex, 1)[0]);
            gameState.actionLog.push(`${player.name} reveals their ${cardName}.`);

            // Check if the player is eliminated
            if (player.cards.length === 0) {
                player.isAlive = false;
                gameState.actionLog.push(`${player.name} has been eliminated!`);

                const alivePlayers = gameState.players.filter(p => p.isAlive);
                if (alivePlayers.length === 1) {
                    const winner = alivePlayers[0];
                    gameState.phase = 'game_over'; // New phase
                    gameState.actionLog.push(`${winner.name} is the last one standing and wins the game!`);
                    io.to(roomId).emit('gameUpdate', gameState);
                    return; // Stop the function here, game is over
                }
            }
        }
        
        // Reset phase and advance turn
        gameState.phase = 'action';
        gameState.playerToReveal = null;
        gameState.passedPlayers = [];
        gameState = advanceTurn(gameState);

        io.to(roomId).emit('gameUpdate', gameState);
    });

    socket.on('challengeResponse', ({ roomId, response }) => {
        const room = rooms[roomId];
        if (!room || !room.gameState || room.gameState.phase !== 'challenge') return;

        let gameState = room.gameState;
        const responderId = socket.id;
        const { action, actorId } = gameState.pendingAction;

        if (response === 'challenge') {
            const challenger = gameState.players.find(p => p.id === responderId);
            const actor = gameState.players.find(p => p.id === actorId);
            const requiredCard = action === 'Tax' ? 'Duke' : null; // We'll add more cards here later

            gameState.actionLog.push(`${challenger.name} challenges ${actor.name}'s claim to be a ${requiredCard}!`);

            // Check if the actor has the required card
            if (actor.cards.includes(requiredCard)) {
            // --- CHALLENGE FAILED ---
            gameState.actionLog.push(`${actor.name} reveals a ${requiredCard}! The challenge fails.`);
            
            // The challenger must reveal a card
            gameState.phase = 'reveal_card';
            gameState.playerToReveal = { id: challenger.id, reason: 'Failed Challenge' };

            // Actor's action succeeds.
            if (action === 'Tax') actor.coins += 3;

            // Actor shuffles the revealed card back and gets a new one
            const cardIndex = actor.cards.indexOf(requiredCard);
            actor.cards.splice(cardIndex, 1); // Remove the card
            gameState.deck.push(requiredCard); // Add it back to the deck
            shuffle(gameState.deck); // Shuffle the deck
            actor.cards.push(gameState.deck.pop()); // Draw a new card

            } else {
            // --- CHALLENGE SUCCEEDED ---
            gameState.actionLog.push(`${actor.name} was bluffing! The challenge succeeds.`);
            
            // The actor's action is cancelled and they must reveal a card
            gameState.phase = 'reveal_card';
            gameState.playerToReveal = { id: actor.id, reason: 'Caught Bluffing' };
            }

        } else if (response === 'pass') {
            // This logic remains the same
            gameState.passedPlayers.push(responderId);
            gameState.actionLog.push(`${gameState.players.find(p => p.id === responderId).name} does not challenge.`);
            
            const numOtherPlayers = gameState.players.length - 1;
            if (gameState.passedPlayers.length === numOtherPlayers) {
            gameState.actionLog.push(`The action is not challenged and succeeds.`);
            const actor = gameState.players.find(p => p.id === actorId);
            if (action === 'Tax') {
                actor.coins += 3;
                gameState.actionLog.push(`${actor.name} gains 3 coins from Tax.`);
            }
            gameState.phase = 'action';
            gameState = advanceTurn(gameState);
            gameState.passedPlayers = [];
            }
        }

        io.to(roomId).emit('gameUpdate', gameState);
    });

    // --- Handle Player Actions ---
    socket.on('performAction', ({ roomId, action }) => {
        const room = rooms[roomId];
        if (!room || !room.gameState) return;
        
        let gameState = room.gameState;
        const playerIndex = gameState.players.findIndex(p => p.id === socket.id);
        
        if (playerIndex !== gameState.currentPlayerIndex) return; // Not their turn
        if (gameState.phase !== 'action') return; // Not the action phase

        const player = gameState.players[playerIndex];
        
        // --- Handle simple actions that don't have challenges ---
        if (action === 'income') {
            player.coins += 1;
            gameState.actionLog.push(`${player.name} takes Income.`);
            // Advance turn
            gameState = advanceTurn(gameState);
            io.to(roomId).emit('gameUpdate', gameState);
            return; // End the function here
        }

        // --- Handle actions that can be challenged ---
        if (action === 'tax') {
            gameState.phase = 'challenge'; // Change the phase
            gameState.pendingAction = {
            action: 'Tax',
            actorName: player.name,
            actorId: player.id
            };
            gameState.actionLog.push(`${player.name} claims to be a Duke to perform TAX.`);
            io.to(roomId).emit('gameUpdate', gameState); // Broadcast the new phase
        }

        // We will add other actions like foreign_aid here
    });

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
            phase: 'action', // Set the initial phase
            pendingAction: null, // No pending action at the start
            passedPlayers: [],
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

    function advanceTurn(gameState) {
        let nextPlayerIndex = gameState.currentPlayerIndex;
        
        // Keep looping until we find a player who is still alive
        do {
            nextPlayerIndex = (nextPlayerIndex + 1) % gameState.players.length;
        } while (!gameState.players[nextPlayerIndex].isAlive);

        gameState.currentPlayerIndex = nextPlayerIndex;
        gameState.actionLog.push(`It is now ${gameState.players[nextPlayerIndex].name}'s turn.`);
        
        return gameState;
    }
});

server.listen(3000, () => {
  console.log('Server running on port 3000');
});
