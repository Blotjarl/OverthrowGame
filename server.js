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
        if (socket.id !== gameState.playerToReveal.id) return;

        const player = gameState.players.find(p => p.id === socket.id);
        const cardIndex = player.cards.indexOf(cardName);
        const reason = gameState.playerToReveal.reason;

        if (cardIndex > -1) {
            player.revealedCards.push(player.cards.splice(cardIndex, 1)[0]);
            gameState.actionLog.push(`${player.name} reveals their ${cardName}.`);

            if (player.cards.length === 0) {
                player.isAlive = false;
                gameState.actionLog.push(`${player.name} has been eliminated!`);
                const alivePlayers = gameState.players.filter(p => p.isAlive);
                if (alivePlayers.length === 1) {
                    const winner = alivePlayers[0];
                    gameState.phase = 'game_over';
                    gameState.actionLog.push(`${winner.name} is the last one standing and wins the game!`);
                    io.to(roomId).emit('gameUpdate', gameState);
                    return;
                }
            }
        }

        // --- NEW LOGIC: Decide what to do based on the REASON for the reveal ---
        if (reason === 'Failed Challenge' || reason === 'Failed Block Challenge') {
            // The original action was legitimate and now must be resolved.
            const { action, actorId, targetId } = gameState.pendingAction;
            const actor = gameState.players.find(p => p.id === actorId);
            const target = gameState.players.find(p => p.id === targetId);

            gameState.actionLog.push(`The original action now proceeds.`);

            if (action.toLowerCase() === 'steal') {
                const coinsToSteal = Math.min(target.coins, 2);
                actor.coins += coinsToSteal;
                target.coins -= coinsToSteal;
                gameState.actionLog.push(`${actor.name} steals ${coinsToSteal} coins from ${target.name}.`);
            } else if (action.toLowerCase() === 'assassinate') {
                actor.coins -= 3;
                gameState.phase = 'reveal_card'; // The target must now reveal a card
                gameState.playerToReveal = { id: targetId, reason: 'Assassinated' };
                io.to(roomId).emit('gameUpdate', gameState); // Send update and wait for second reveal
                return; // IMPORTANT: Stop here, don't advance turn yet.
            }
            // Add other actions like Tax here if they get challenged
        }

        // For all other cases (Caught Bluffing, Overthrown, etc.) or after a successful action,
        // we clean up and advance the turn.
        gameState.phase = 'action';
        gameState.playerToReveal = null;
        gameState.pendingAction = null;
        gameState.pendingBlock = null;
        gameState.passedPlayers = [];
        gameState = advanceTurn(gameState);

        io.to(roomId).emit('gameUpdate', gameState);
    });

    socket.on('blockResponse', ({ roomId, response }) => {
        const room = rooms[roomId];
        if (!room || !room.gameState || room.gameState.phase !== 'block_challenge') return;

        let gameState = room.gameState;
        const responderId = socket.id;
        const { blockerId, requiredCard } = gameState.pendingBlock;
        const blocker = gameState.players.find(p => p.id === blockerId);

        // --- VALIDATION: Ensure responder is alive and not the blocker ---
        const responder = gameState.players.find(p => p.id === responderId);
        if (!responder || !responder.isAlive || responder.id === blockerId) return;


        if (response === 'challenge') {
            gameState.actionLog.push(`${responder.name} challenges ${blocker.name}'s block!`);

            // Check if the blocker actually has one of the required cards
            const hasBlockCard = Array.isArray(requiredCard)
                ? requiredCard.some(card => blocker.cards.includes(card))
                : blocker.cards.includes(requiredCard);

            if (hasBlockCard) {
                // --- BLOCK CHALLENGE FAILED ---
                // The blocker was telling the truth. The challenger loses a card.
                gameState.actionLog.push(`${blocker.name} reveals a valid block card! The challenge fails.`);
                gameState.phase = 'reveal_card';
                gameState.playerToReveal = { id: responder.id, reason: 'Failed Block Challenge' };

                // The original action is successfully blocked.
                gameState.actionLog.push(`The original action is blocked.`);
                
                // Find the revealed card, shuffle it back, and draw a new one for the blocker.
                const cardToReveal = Array.isArray(requiredCard)
                    ? requiredCard.find(card => blocker.cards.includes(card))
                    : requiredCard;
                const cardIndex = blocker.cards.indexOf(cardToReveal);
                blocker.cards.splice(cardIndex, 1);
                gameState.deck.push(cardToReveal);
                shuffle(gameState.deck);
                blocker.cards.push(gameState.deck.pop());

            } else {
                // --- BLOCK CHALLENGE SUCCEEDED ---
                // The blocker was bluffing. The blocker loses a card.
                gameState.actionLog.push(`${blocker.name} was bluffing the block! The challenge succeeds.`);
                gameState.phase = 'reveal_card';
                gameState.playerToReveal = { id: blocker.id, reason: 'Caught Bluffing Block' };

                 // --- NEW LOGIC STARTS HERE ---
                // The original action now goes through successfully.
                const originalAction = gameState.pendingAction.action;
                const originalActor = gameState.players.find(p => p.id === gameState.pendingAction.actorId);

                if (originalAction.toLowerCase() === 'steal') {
                    // The 'blocker' is the original target who failed the block.
                    const coinsToSteal = Math.min(blocker.coins, 2); 
                    originalActor.coins += coinsToSteal;
                    blocker.coins -= coinsToSteal;
                    gameState.actionLog.push(`${originalActor.name}'s steal succeeds, taking ${coinsToSteal} coins from ${blocker.name}.`);
                }
            }

        } else if (response === 'pass') {
            if (!gameState.passedPlayers.includes(responderId)) {
                gameState.passedPlayers.push(responderId);
            }
            gameState.actionLog.push(`${responder.name} does not challenge the block.`);

            // Check if all possible challengers have passed.
            const numPossibleChallengers = gameState.players.filter(p => p.isAlive && p.id !== blockerId).length;
            if (gameState.passedPlayers.length === numPossibleChallengers) {
                // --- BLOCK SUCCEEDS UNCHALLENGED ---
                gameState.actionLog.push(`The block is not challenged and succeeds. The original action is cancelled.`);
                
                // Reset for the next turn
                gameState.phase = 'action';
                gameState = advanceTurn(gameState);
            }
        }

        // If the phase changed, clean up and broadcast
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
                'tax': 'Duke',
                'assassinate': 'Assassin',
                'steal': 'Captain',
                'exchange': 'Ambassador'
            }[action.toLowerCase()];

            gameState.actionLog.push(`${challenger.name} challenges ${actor.name}'s claim to be a ${requiredCard}!`);

            if (actor.cards.includes(requiredCard)) {
                // CHALLENGE FAILED
                gameState.actionLog.push(`${actor.name} reveals a ${requiredCard}! The challenge fails.`);
                gameState.phase = 'reveal_card';
                gameState.playerToReveal = { id: challenger.id, reason: 'Failed Challenge' };
                // Actor's action still needs to be resolved after the reveal. We will handle this later.
                // For now, we just set up the reveal.
                const cardIndex = actor.cards.indexOf(requiredCard);
                actor.cards.splice(cardIndex, 1);
                gameState.deck.push(requiredCard);
                shuffle(gameState.deck);
                actor.cards.push(gameState.deck.pop());
            } else {
                // CHALLENGE SUCCEEDED
                gameState.actionLog.push(`${actor.name} was bluffing! The challenge succeeds.`);
                gameState.phase = 'reveal_card';
                gameState.playerToReveal = { id: actor.id, reason: 'Caught Bluffing' };
                // Action is cancelled, turn will advance after reveal.
            }
            // Clean up and broadcast
            gameState.passedPlayers = [];
            io.to(roomId).emit('gameUpdate', gameState);

        } else if (response === 'pass') {
            gameState.passedPlayers.push(responderId);
            gameState.actionLog.push(`${responder.name} does not challenge.`);
            
            // Check if all other living players have passed
            const numPossibleChallengers = gameState.players.filter(p => p.isAlive && p.id !== actorId).length;

            if (gameState.passedPlayers.length === numPossibleChallengers) {
                gameState.actionLog.push(`The action is not challenged.`);
                
                const blockableActions = ['assassinate', 'steal', 'foreign_aid'];

                // If the action is blockable, move to a new phase for the target to respond.
                if (blockableActions.includes(action.toLowerCase())) {
                    gameState.phase = 'declare_block'; // The correct new phase
                } else {
                    // If the action was NOT blockable (like Tax), it succeeds immediately.
                    const actor = gameState.players.find(p => p.id === actorId);
                    if (action.toLowerCase() === 'tax') {
                        actor.coins += 3;
                        gameState.actionLog.push(`${actor.name} gains 3 coins from Tax.`);
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
            gameState.actionLog.push(`${blocker.name} does not block the ${originalAction}.`);
            
            // Resolve the original action (e.g., the steal)
            const actor = gameState.players.find(p => p.id === gameState.pendingAction.actorId);
            
            if (originalAction.toLowerCase() === 'steal') {
                const coinsToSteal = Math.min(blocker.coins, 2);
                actor.coins += coinsToSteal;
                blocker.coins -= coinsToSteal;
                gameState.actionLog.push(`${actor.name} steals ${coinsToSteal} coins from ${blocker.name}.`);

                // Reset for the next turn
                gameState.phase = 'action';
                gameState.pendingAction = null;
                gameState = advanceTurn(gameState);

            } else if (originalAction.toLowerCase() === 'assassinate') {
                // The assassination succeeds, target must reveal a card.
                actor.coins -= 3; // Pay the cost
                gameState.phase = 'reveal_card';
                gameState.playerToReveal = { id: targetId, reason: 'Assassinated' };
                gameState.pendingAction = null; // Clear the pending action
            }

        } else {
            // --- The player IS declaring a block ---
            gameState.actionLog.push(`${blocker.name} claims to have a ${blockType} to block the ${originalAction}!`);
            
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
    socket.on('performAction', ({ roomId, action, targetId }) => {
        const room = rooms[roomId];
        if (!room || !room.gameState) return;
        
        let gameState = room.gameState;
        const playerIndex = gameState.players.findIndex(p => p.id === socket.id);
        
        if (playerIndex !== gameState.currentPlayerIndex) return; // Not their turn
        if (gameState.phase !== 'action') return; // Not the action phase

        const player = gameState.players[playerIndex];
        
        if (action.toLowerCase() === 'overthrow') {
                if (player.coins < 7) {
                    console.log("Not enough coins for Overthrow");
                    return; 
                }

                player.coins -= 7;
                const target = gameState.players.find(p => p.id === targetId);
                gameState.actionLog.push(`${player.name} pays 7 coins to Overthrow ${target.name}! This cannot be blocked.`);

                // Go directly to the reveal phase for the target
                gameState.phase = 'reveal_card';
                gameState.playerToReveal = { id: targetId, reason: 'Overthrown' };
                
                io.to(roomId).emit('gameUpdate', gameState);
                return; // The action is handled, so we stop the function here.
            }

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
            case 'foreign_aid': // <-- ADD THIS NEW CASE
            logMessage = `${player.name} is attempting to take Foreign Aid.`;
            requiredCard = null; // Foreign aid itself cannot be challenged, only blocked.
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
                targetId: targetId,
                requiredCard: requiredCard
            };
            gameState.actionLog.push(logMessage);
            io.to(roomId).emit('gameUpdate', gameState);
        } 
        else if (action === 'foreign_aid') { 
            gameState.phase = 'block_declaration_period'; // The new phase for blocking
            gameState.pendingAction = {
                action: 'Foreign Aid',
                actorId: player.id,
                actorName: player.name
            };
            gameState.actionLog.push(logMessage);
            io.to(roomId).emit('gameUpdate', gameState);
        }

    });

    socket.on('foreignAidResponse', ({ roomId, response }) => {
        const room = rooms[roomId];
        if (!room || !room.gameState || room.gameState.phase !== 'block_declaration_period') return;

        let gameState = room.gameState;
        const responderId = socket.id;
        const actorId = gameState.pendingAction.actorId;

        // --- Validation: Ensure responder is alive and not the one taking the action ---
        const responder = gameState.players.find(p => p.id === responderId);
        if (!responder || !responder.isAlive || responder.id === actorId) return;

        if (response === 'block') {
            // --- A player is claiming to have a Duke to block ---
            gameState.actionLog.push(`${responder.name} claims to have a Duke to BLOCK the Foreign Aid!`);
            
            // Move to a new phase where this block can be challenged
            gameState.phase = 'block_challenge';
            gameState.pendingBlock = {
                blockerId: responder.id,
                blockingCard: 'Duke'
            };
            // Clear passers for the new challenge round
            gameState.passedPlayers = [];

        } else if (response === 'pass') {
            // --- A player is not blocking ---
            if (!gameState.passedPlayers.includes(responderId)) {
                gameState.passedPlayers.push(responderId);
            }
            gameState.actionLog.push(`${responder.name} does not block.`);

            // Check if all other living players have passed
            const numPossibleBlockers = gameState.players.filter(p => p.isAlive && p.id !== actorId).length;

            if (gameState.passedPlayers.length === numPossibleBlockers) {
                // --- FOREIGN AID SUCCEEDS UNCHALLENGED ---
                const actor = gameState.players.find(p => p.id === actorId);
                actor.coins += 2;
                gameState.actionLog.push(`${actor.name}'s Foreign Aid succeeds. They gain 2 coins.`);
                
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
