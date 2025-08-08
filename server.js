const express = require('express');
const http = require('http');



const { Server } = require('socket.io');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Allow all origins for simplicity
        methods: ["GET", "POST"]
    }
});

// Create a Redis client
const redisClient = createClient({ url: process.env.REDIS_URL });

// Connect the Redis client and set up the adapter
(async () => {
    try {
        await redisClient.connect();
        const subClient = redisClient.duplicate();
        io.adapter(createAdapter(redisClient, subClient));
        console.log('Connected to Redis and using Redis adapter.');
    } catch (err) {
        console.error('Failed to connect to Redis', err);
    }
})();




const { v4: uuidv4 } = require('uuid');

// Serve all static files (index.html, images, etc.) from the 'public' directory
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

const CARDS = ['Tax Collector', 'Warrior', 'Thief', 'Courtier', 'Defender'];
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

function getTimeStamp() {
    const date = new Date();
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    return `[${hours}:${minutes}:${seconds}]`;
}

function generateRoomId() {
    return uuidv4().substring(0,6).toUpperCase(); // Generate a short room ID
}

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    let currentRoom = null;

    socket.on('chatMessage', ({ roomId, message }) => {
        const room = rooms[roomId];
        if (!room || !room.gameState) return;

        const player = room.gameState.players.find(p => p.id === socket.id);
        if (!player) return;

        // Sanitize message to prevent HTML injection (basic example)
        const sanitizedMessage = message.replace(/</g, "&lt;").replace(/>/g, "&gt;");

        // Format the message and add it to the log
        const chatLogEntry = `${getTimeStamp()} <strong>${player.name}:</strong> ${sanitizedMessage}`;
        room.gameState.actionLog.unshift(chatLogEntry);

        // Broadcast the updated game state to everyone
        io.to(roomId).emit('gameUpdate', room.gameState);
    });

    socket.on('revealCard', ({ roomId, cardName }) => {
        const room = rooms[roomId];
        if (!room || !room.gameState || room.gameState.phase !== 'reveal_card') return;

        let gameState = room.gameState;
        if (socket.id !== gameState.playerToReveal.id) return;

        const player = gameState.players.find(p => p.id === socket.id);
        const cardIndex = player.cards.indexOf(cardName);
        const reason = gameState.playerToReveal.reason;
        const pendingAction = gameState.pendingAction; // Keep a reference to the original action

        // Reveal the card and check for elimination
        if (cardIndex > -1) {
            player.revealedCards.push(player.cards.splice(cardIndex, 1)[0]);
            gameState.actionLog.unshift(`${getTimeStamp()} ${player.name} reveals their ${cardName}.`);

            if (player.cards.length === 0) {
                player.isAlive = false;
                gameState.actionLog.unshift(`${getTimeStamp()} ${player.name} has been eliminated!`);
                const alivePlayers = gameState.players.filter(p => p.isAlive);
                if (alivePlayers.length === 1) {
                    const winner = alivePlayers[0];
                    gameState.phase = 'game_over';
                    gameState.actionLog.unshift(`${getTimeStamp()} ${winner.name} is the last one standing and wins the game!`);
                    io.to(roomId).emit('gameUpdate', gameState);
                    return; // Game over
                }
            }
        }

        // --- NEW, SMARTER LOGIC ---
        let turnShouldAdvance = true;

        // Check if the original action should now proceed
        if ((reason === 'Failed Challenge' || reason === 'Caught Bluffing Block') && pendingAction) {
            gameState.actionLog.unshift(`${getTimeStamp()} The original action (${pendingAction.action}) now proceeds.`);

            const actor = gameState.players.find(p => p.id === pendingAction.actorId);
            const target = gameState.players.find(p => p.id === pendingAction.targetId);

            switch (pendingAction.action.toLowerCase()) {
                case 'thieve':
                    const ducatsToSteal = Math.min(target.ducats, 2);
                    actor.ducats += ducatsToSteal;
                    target.ducats -= ducatsToSteal;
                    gameState.actionLog.unshift(`${getTimeStamp()} ${actor.name} thieves ${ducatsToSteal} ducats from ${target.name}.`);
                    break;
                case 'attack':
                    actor.ducats -= 3;
                    gameState.phase = 'reveal_card';
                    gameState.playerToReveal = { id: target.id, reason: 'Attacked' };
                    turnShouldAdvance = false; // Wait for the second reveal
                    break;
                case 'levy':
                    actor.ducats += 3;
                    gameState.actionLog.unshift(`${getTimeStamp()} ${actor.name} gains 3 ducats from Levy.`);
                    break;
            }
        }

        // If the turn should advance, clean up the game state.
        if (turnShouldAdvance) {
            gameState.phase = 'action';
            gameState.playerToReveal = null;
            gameState.pendingAction = null;
            gameState.pendingBlock = null;
            gameState.passedPlayers = [];
            gameState = advanceTurn(gameState);
        }
        
        io.to(roomId).emit('gameUpdate', gameState);
    });

    socket.on('blockResponse', ({ roomId, response }) => {
        const room = rooms[roomId];
        if (!room || !room.gameState || room.gameState.phase !== 'block_challenge') return;

        let gameState = room.gameState;
        const responderId = socket.id;
        // --- FIX IS HERE: Use blockingCard, not requiredCard ---
        const { blockerId, blockingCard } = gameState.pendingBlock; 
        const blocker = gameState.players.find(p => p.id === blockerId);

        const responder = gameState.players.find(p => p.id === responderId);
        if (!responder || !responder.isAlive || responder.id === blockerId) return;

        if (response === 'challenge') {
            gameState.actionLog.unshift(`${getTimeStamp()} ${responder.name} challenges ${blocker.name}'s block!`);

            // --- FIX IS HERE: Check for blockingCard ---
            const hasBlockCard = Array.isArray(blockingCard)
                ? blockingCard.some(card => blocker.cards.includes(card))
                : blocker.cards.includes(blockingCard);

            if (hasBlockCard) {
                // --- BLOCK CHALLENGE FAILED ---
                gameState.actionLog.unshift(`${getTimeStamp()} ${blocker.name} reveals a valid block card! The challenge fails.`);
                gameState.phase = 'reveal_card';
                gameState.playerToReveal = { id: responder.id, reason: 'Failed Block Challenge' };
                gameState.actionLog.unshift(`${getTimeStamp()} The original action is blocked.`);

                // --- FIX IS HERE: Find the correct blockingCard to reveal ---
                const cardToReveal = Array.isArray(blockingCard)
                    ? blockingCard.find(card => blocker.cards.includes(card))
                    : blockingCard;
                const cardIndex = blocker.cards.indexOf(cardToReveal);
                blocker.cards.splice(cardIndex, 1);
                gameState.deck.unshift(cardToReveal);
                blocker.cards.push(gameState.deck.pop());
                gameState.actionLog.unshift(`${getTimeStamp()} ${blocker.name} returns their card to the deck and draws a new one.`);

            } else {
                // --- BLOCK CHALLENGE SUCCEEDED ---
                gameState.actionLog.unshift(`${getTimeStamp()} ${blocker.name} was bluffing the block! The challenge succeeds.`);
                gameState.phase = 'reveal_card';
                gameState.playerToReveal = { id: blocker.id, reason: 'Caught Bluffing Block' };

                const originalAction = gameState.pendingAction.action;
                const originalActor = gameState.players.find(p => p.id === gameState.pendingAction.actorId);
                
                if (originalAction.toLowerCase() === 'thieve') {
                    const ducatsToSteal = Math.min(blocker.ducats, 2);
                    originalActor.ducats += ducatsToSteal;
                    blocker.ducats -= ducatsToSteal;
                    gameState.actionLog.unshift(`${getTimeStamp()} ${originalActor.name}'s thieve succeeds, taking ${ducatsToSteal} ducats from ${blocker.name}.`);
                }
            }

        } else if (response === 'pass') {
            if (!gameState.passedPlayers.includes(responderId)) {
                gameState.passedPlayers.push(responderId);
            }
            gameState.actionLog.unshift(`${getTimeStamp()} ${responder.name} does not challenge the block.`);

            const numPossibleChallengers = gameState.players.filter(p => p.isAlive && p.id !== blockerId).length;
            if (gameState.passedPlayers.length === numPossibleChallengers) {
                gameState.actionLog.unshift(`${getTimeStamp()} The block is not challenged and succeeds. The original action is cancelled.`);
                gameState.phase = 'action';
                gameState = advanceTurn(gameState);
            }
        }

        if (gameState.phase !== 'block_challenge') {
            gameState.pendingAction = null;
            gameState.pendingBlock = null;
            gameState.passedPlayers = [];
            io.to(roomId).emit('gameUpdate', gameState);
        }
    });

    socket.on('challengeResponse', ({ roomId, response }) => {
        const room = rooms[roomId];
        if (!room || !room.gameState || room.gameState.phase !== 'challenge') return;

        let gameState = room.gameState;
        const responderId = socket.id;

        // --- Validation for responder ---
        const responder = gameState.players.find(p => p.id === responderId);
        if (!responder || !responder.isAlive) {
            console.log(`Dead player ${responderId} tried to respond.`);
            return;
        }
        if (gameState.passedPlayers.includes(responderId)) {
            console.log(`Player ${responderId} already passed.`);
            return;
        }
        // --- End Validation ---

        const { action, actorId } = gameState.pendingAction;

        if (response === 'challenge') {
            // This entire block for handling a direct challenge remains the same
            const challenger = gameState.players.find(p => p.id === responderId);
            const actor = gameState.players.find(p => p.id === actorId);
            const requiredCard = {
                'levy': 'Tax Collector',
                'attack': 'Warrior',
                'thieve': 'Thief',
                'exchange': 'Courtier'
            }[action.toLowerCase()];

            gameState.actionLog.unshift(`${getTimeStamp()} ${challenger.name} challenges ${actor.name}'s claim to be a ${requiredCard}!`);

            if (actor.cards.includes(requiredCard)) {
                // CHALLENGE FAILED
                gameState.actionLog.unshift(`${getTimeStamp()} ${actor.name} reveals a ${requiredCard}! The challenge fails.`);
                gameState.phase = 'reveal_card';
                gameState.playerToReveal = { id: challenger.id, reason: 'Failed Challenge' };
                // Actor's action still needs to be resolved after the reveal. We will handle this later.
                // For now, we just set up the reveal.
                const cardIndex = actor.cards.indexOf(requiredCard);
                actor.cards.splice(cardIndex, 1);
                gameState.deck.push(requiredCard);
                actor.cards.push(gameState.deck.pop());
                gameState.actionLog.unshift(`${getTimeStamp()} ${actor.name} shuffles their card back into the deck and draws a new one.`);
            } else {
                // CHALLENGE SUCCEEDED
                gameState.actionLog.unshift(`${getTimeStamp()} ${actor.name} was bluffing! The challenge succeeds.`);
                gameState.phase = 'reveal_card';
                gameState.playerToReveal = { id: actor.id, reason: 'Caught Bluffing' };
                // Action is cancelled, turn will advance after reveal.
            }
            // Clean up and broadcast
            gameState.passedPlayers = [];
            io.to(roomId).emit('gameUpdate', gameState);

        } else if (response === 'pass') {
            gameState.passedPlayers.push(responderId);
            gameState.actionLog.unshift(`${getTimeStamp()} ${responder.name} does not challenge.`);
            
            // Check if all other living players have passed
            const numPossibleChallengers = gameState.players.filter(p => p.isAlive && p.id !== actorId).length;

            if (gameState.passedPlayers.length === numPossibleChallengers) {
                gameState.actionLog.unshift(`${getTimeStamp()} The action is not challenged.`);
                
                const blockableActions = ['attack', 'thieve', 'smuggle_goods'];

                // If the action is blockable, move to a new phase for the target to respond.
                if (blockableActions.includes(action.toLowerCase())) {
                    gameState.phase = 'declare_block'; // The correct new phase
                } else {
                    // If the action was NOT blockable (like Levy), it succeeds immediately.
                    const actor = gameState.players.find(p => p.id === actorId);
                    if (action.toLowerCase() === 'levy') {
                        actor.ducats += 3;
                        gameState.actionLog.unshift(`${getTimeStamp()} ${actor.name} gains 3 ducats from Levy.`);
                    }
                    if (action.toLowerCase() === 'exchange') {
                        gameState.phase = 'exchange_cards';
                        const newCards = [gameState.deck.pop(), gameState.deck.pop()];
                        gameState.exchangeInfo = {
                            playerId: actor.id,
                            options: [...actor.cards, ...newCards]
                        };
                    }
                    
                    // If the action is fully resolved now, advance the turn.
                    if (gameState.phase !== 'exchange_cards') {
                        gameState.phase = 'action';
                        gameState = advanceTurn(gameState);
                    }
                }
                // Clean up and broadcast
                gameState.passedPlayers = [];
                io.to(roomId).emit('gameUpdate', gameState);
            }
        }
    });

    socket.on('returnExchangeCards', ({ roomId, keptCards }) => {
        const room = rooms[roomId];
        if (!room || !room.gameState) return;

        let gameState = room.gameState;
        if (gameState.phase !== 'exchange_cards' || socket.id !== gameState.exchangeInfo.playerId) return;

        const player = gameState.players.find(p => p.id === socket.id);
        
        // --- THIS IS THE CORRECTED LOGIC ---
        const allOptions = [...gameState.exchangeInfo.options]; // Create a mutable copy
        const returnedCards = [];

        // Figure out which cards to return without destroying the keptCards array
        for (const card of keptCards) {
            const index = allOptions.indexOf(card);
            if (index > -1) {
                allOptions.splice(index, 1);
            }
        }
        // Whatever is left in allOptions are the cards to be returned to the deck.
        returnedCards.push(...allOptions);
        // --- END OF CORRECTED LOGIC ---

        // Now, we can safely update the player's hand
        player.cards = keptCards;
        
        // Return the other cards to the bottom of the deck
        gameState.deck.unshift(...returnedCards);

        gameState.actionLog.unshift(`${getTimeStamp()} ${player.name} completes their exchange.`);

        // Reset and advance turn
        gameState.phase = 'action';
        gameState.exchangeInfo = null;
        gameState = advanceTurn(gameState);
        
        io.to(roomId).emit('gameUpdate', gameState);
    });

    socket.on('declareBlock', ({ roomId, blockType }) => {
        const room = rooms[roomId];
        if (!room || !room.gameState || room.gameState.phase !== 'declare_block') return;

        let gameState = room.gameState;
        const targetId = gameState.pendingAction.targetId;

        // --- VALIDATION: Make sure the right person is declaring the block ---
        if (socket.id !== targetId) {
            console.log(`Player ${socket.id} tried to declare a block when they were not the target.`);
            return;
        }

        const blocker = gameState.players.find(p => p.id === targetId);
        const originalAction = gameState.pendingAction.action;

        if (blockType === 'No Block') {
            // --- The action succeeds because it was not blocked ---
            gameState.actionLog.unshift(`${getTimeStamp()} ${blocker.name} does not block the ${originalAction}.`);
            
            // Resolve the original action (e.g., the steal)
            const actor = gameState.players.find(p => p.id === gameState.pendingAction.actorId);
            
            if (originalAction.toLowerCase() === 'thieve') {
                const ducatsToSteal = Math.min(blocker.ducats, 2);
                actor.ducats += ducatsToSteal;
                blocker.ducats -= ducatsToSteal;
                gameState.actionLog.unshift(`${getTimeStamp()} ${actor.name} thieves ${ducatsToSteal} ducats from ${blocker.name}.`);


                // Reset for the next turn
                gameState.phase = 'action';
                gameState.pendingAction = null;
                gameState = advanceTurn(gameState);

            } else if (originalAction.toLowerCase() === 'attack') {
                // The attack succeeds, target must reveal a card.
                actor.ducats -= 3; // Pay the cost
                gameState.phase = 'reveal_card';
                gameState.playerToReveal = { id: targetId, reason: 'Attacked' };
                gameState.pendingAction = null; // Clear the pending action
            }

        } else {
            // --- The player IS declaring a block ---
            gameState.actionLog.unshift(`${getTimeStamp()} ${blocker.name} claims to have a ${blockType} to block the ${originalAction}!`);

            // Move to a new phase where this block can be challenged
            gameState.phase = 'block_challenge';
            gameState.pendingBlock = {
                blockerId: blocker.id,
                blockingCard: blockType // e.g., 'Captain' or 'Ambassador'
            };
        }

    io.to(roomId).emit('gameUpdate', gameState);
});

    // --- Handle Player Actions ---
    // In server.js, replace your entire performAction listener with this one.

    socket.on('performAction', ({ roomId, action, targetId }) => {
        const room = rooms[roomId];
        if (!room || !room.gameState) return;
        
        let gameState = room.gameState;
        const playerIndex = gameState.players.findIndex(p => p.id === socket.id);
        
        if (playerIndex !== gameState.currentPlayerIndex || gameState.phase !== 'action') return;

        const player = gameState.players[playerIndex];
        
        if (action.toLowerCase() === 'overthrow') {
            if (player.ducats < 7) return;
            player.ducats -= 7;
            const target = gameState.players.find(p => p.id === targetId);
            gameState.actionLog.unshift(`${getTimeStamp()} ${player.name} pays 7 ducats to Overthrow ${target.name}! This cannot be blocked.`);
            gameState.phase = 'reveal_card';
            gameState.playerToReveal = { id: targetId, reason: 'Overthrown' };
            io.to(roomId).emit('gameUpdate', gameState);
            return;
        }

        // --- THIS IS THE CORRECTED BLOCK ---
        if (action === 'harvest_crop') { // Corrected from 'income'
            player.ducats += 1;
            gameState.actionLog.unshift(`${getTimeStamp()} ${player.name} Harvests Crop.`);
            gameState = advanceTurn(gameState);
            io.to(roomId).emit('gameUpdate', gameState);
            return; 
        }
        // --- END OF CORRECTION ---

        let requiredCard = null;
        let logMessage = '';
        
        switch (action) {
            case 'levy':
                requiredCard = 'Tax Collector';
                logMessage = `${player.name} claims to be a Tax Collector to perform LEVY.`;
                break;
            case 'smuggle_goods':
                logMessage = `${player.name} is attempting to Smuggle Goods.`;
                requiredCard = null;
                break;
            case 'attack':
                if (player.ducats < 3) return;
                requiredCard = 'Warrior';
                const target = gameState.players.find(p => p.id === targetId);
                logMessage = `${player.name} claims to be a Warrior and pays 3 ducats to ATTACK ${target.name}.`;
                break;
            case 'thieve':
                requiredCard = 'Thief';
                const stealTarget = gameState.players.find(p => p.id === targetId);
                logMessage = `${player.name} claims to be a Thief to THIEVE from ${stealTarget.name}.`;
                break;
            case 'exchange':
                requiredCard = 'Courtier';
                logMessage = `${player.name} claims to be a Courtier to perform an EXCHANGE.`;
                break;
        }

        if (requiredCard) {
            gameState.phase = 'challenge';
            gameState.pendingAction = {
                action: action,
                actorId: player.id,
                actorName: player.name,
                targetId: targetId,
                requiredCard: requiredCard
            };
            gameState.actionLog.unshift(`${getTimeStamp()} ${logMessage}`);
            io.to(roomId).emit('gameUpdate', gameState);
        } 
        else if (action === 'smuggle_goods') { 
            gameState.phase = 'block_declaration_period';
            gameState.pendingAction = {
                action: 'Smuggle Goods',
                actorId: player.id,
                actorName: player.name
            };
            gameState.actionLog.unshift(`${getTimeStamp()} ${logMessage}`);
            io.to(roomId).emit('gameUpdate', gameState);
        }
    });

    socket.on('smuggleGoodsResponse', ({ roomId, response }) => {
        const room = rooms[roomId];
        if (!room || !room.gameState || room.gameState.phase !== 'block_declaration_period') return;

        let gameState = room.gameState;
        const responderId = socket.id;
        const actorId = gameState.pendingAction.actorId;

        // --- Validation: Ensure responder is alive and not the one taking the action ---
        const responder = gameState.players.find(p => p.id === responderId);
        if (!responder || !responder.isAlive || responder.id === actorId) return;

        if (response === 'block') {
            // --- A player is claiming to have a Tax Collector to block ---
            gameState.actionLog.unshift(`${getTimeStamp()} ${responder.name} claims to have a Tax Collector to BLOCK the Smuggle Goods!`);

            // Move to a new phase where this block can be challenged
            gameState.phase = 'block_challenge';
            gameState.pendingBlock = {
                blockerId: responder.id,
                blockingCard: 'Tax Collector'
            };
            // Clear passers for the new challenge round
            gameState.passedPlayers = [];

        } else if (response === 'pass') {
            // --- A player is not blocking ---
            if (!gameState.passedPlayers.includes(responderId)) {
                gameState.passedPlayers.push(responderId);
            }
            gameState.actionLog.unshift(`${getTimeStamp()} ${responder.name} does not block.`);

            // Check if all other living players have passed
            const numPossibleBlockers = gameState.players.filter(p => p.isAlive && p.id !== actorId).length;

            if (gameState.passedPlayers.length === numPossibleBlockers) {
                // --- SMUGGLING SUCCEEDS UNCHALLENGED ---
                const actor = gameState.players.find(p => p.id === actorId);
                actor.ducats += 2;
                gameState.actionLog.unshift(`${getTimeStamp()} ${actor.name}'s Smuggling succeeds. They gain 2 ducats.`);

                // Reset for the next turn
                gameState.phase = 'action';
                gameState.pendingAction = null;
                gameState.passedPlayers = [];
                gameState = advanceTurn(gameState);
            }
        }

        io.to(roomId).emit('gameUpdate', gameState);
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
            ducats: 2,
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
        gameState.actionLog.unshift(`${getTimeStamp()} It is now ${gameState.players[nextPlayerIndex].name}'s turn.`);

        return gameState;
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
