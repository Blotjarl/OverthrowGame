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
        const responder = gameState.players.find(p => p.id === responderId);
            if (!responder || !responder.isAlive) {
                console.log(`Dead player ${responderId} tried to respond.`);
                return; // Stop the function
            }

        const { action, actorId } = gameState.pendingAction;

        if (response === 'challenge') {
            const challenger = gameState.players.find(p => p.id === responderId);
            const actor = gameState.players.find(p => p.id === actorId);
            const requiredCard = {
                'tax': 'Duke',
                'assassinate': 'Assassin',
                'steal': 'Captain',
                'exchange': 'Ambassador'
            }[action];      

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
            // Check if player passed already
            if (gameState.passedPlayers.includes(responderId)) {
                console.log(`Player ${responderId} already passed.`);
                return;
            }

            gameState.passedPlayers.push(responderId);
            gameState.actionLog.push(`${gameState.players.find(p => p.id === responderId).name} does not challenge.`);
            
            const numOtherPlayers = gameState.players.length - 1;
            if (gameState.passedPlayers.length === numOtherPlayers) {
                gameState.actionLog.push(`The action is not challenged and succeeds.`);
                const actor = gameState.players.find(p => p.id === actorId);
                switch (action) {
                case 'tax':
                    actor.coins += 3;
                    gameState.actionLog.push(`${actor.name} gains 3 coins from Tax.`);
                    break;
                case 'assassinate':
                    actor.coins -= 3; // Player pays the cost
                    // Set the phase so the target must reveal a card
                    gameState.phase = 'reveal_card';
                    gameState.playerToReveal = { id: gameState.pendingAction.targetId, reason: 'Assassinated' };
                    break;
                case 'steal':
                    const target = gameState.players.find(p => p.id === gameState.pendingAction.targetId);
                    const coinsToSteal = Math.min(target.coins, 2);
                    actor.coins += coinsToSteal;
                    target.coins -= coinsToSteal;
                    gameState.actionLog.push(`${actor.name} steals ${coinsToSteal} coins from ${target.name}.`);
                    break;
                case 'exchange':
                    // Set a new phase for the exchange process
                    gameState.phase = 'exchange_cards';
                    const newCards = [gameState.deck.pop(), gameState.deck.pop()];
                    gameState.exchangeInfo = {
                        playerId: actor.id,
                        options: [...actor.cards, ...newCards]
                    };
                    break;
    }

// IMPORTANT: Only advance the turn if the action is fully resolved.
// Actions like 'assassinate' and 'exchange' lead to new phases.
if (gameState.phase === 'challenge') {
    gameState.phase = 'action';
    gameState = advanceTurn(gameState);
}

gameState.passedPlayers = []; // Always clear the passers
            }
        }

        io.to(roomId).emit('gameUpdate', gameState);
    });

    socket.on('returnExchangeCards', ({ roomId, keptCards }) => {
        let gameState = room.gameState;
        if (gameState.phase !== 'exchange_cards' || socket.id !== gameState.exchangeInfo.playerId) return;

        const player = gameState.players.find(p => p.id === socket.id);
        
        // Determine which cards were returned
        const allOptions = gameState.exchangeInfo.options;
        const returnedCards = allOptions.filter(card => !keptCards.includes(card) || (keptCards.splice(keptCards.indexOf(card), 1) && false));

        // Update player's hand
        player.cards = keptCards;
        
        // Return the other cards to the deck and shuffle
        gameState.deck.unshift(...returnedCards);
        
        gameState.actionLog.push(`${player.name} completes their exchange.`);

        // Reset and advance turn
        gameState.phase = 'action';
        gameState.exchangeInfo = null;
        gameState = advanceTurn(gameState);
        
        io.to(roomId).emit('gameUpdate', gameState);
    });

    // --- Handle Player Actions ---
    socket.on('performAction', ({ roomId, action, targetId }) => {
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
        // Determine the card and log message for the action
        switch (action) {
            case 'tax':
            requiredCard = 'Duke';
            logMessage = `${player.name} claims to have a Duke to perform TAX.`;
            break;
            case 'assassinate':
            if (player.coins < 3) return; // Not enough coins
            requiredCard = 'Assassin';
            const target = gameState.players.find(p => p.id === targetId);
            logMessage = `${player.name} claims to have an Assassin and pays 3 coins to Assassinate ${target.name}.`;
            break;
            case 'steal':
            requiredCard = 'Captain';
            const stealTarget = gameState.players.find(p => p.id === targetId);
            logMessage = `${player.name} claims to have a Captain to STEAL from ${stealTarget.name}.`;
            break;
            case 'exchange':
            requiredCard = 'Ambassador';
            logMessage = `${player.name} claims to have an Ambassador to perform an EXCHANGE.`;
            break;
        }

        // If it's a challengeable action, set the game phase
        if (requiredCard) {
            gameState.phase = 'challenge';
            gameState.pendingAction = {
                action: action,
                actorId: player.id,
                actorName: player.name,
                targetId: targetId, // Will be null for tax/exchange
                requiredCard: requiredCard
            };
            gameState.actionLog.push(logMessage);
            io.to(roomId).emit('gameUpdate', gameState);
        }
 
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
