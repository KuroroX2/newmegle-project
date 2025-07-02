const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const mongoose = require('mongoose');
require('dotenv').config(); // Cargar variables de entorno del archivo .env

const app = express();
const server = http.createServer(app);
// Configura Socket.IO para que se ejecute en el puerto 10000 para Render
const io = socketIo(server, {
    cors: {
        origin: "*", // Permite cualquier origen para desarrollo
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 10000; // Render usará el puerto 10000

// --- Configuración de la Base de Datos (MongoDB) ---
// Conecta a MongoDB Atlas. La URL debe venir de las variables de entorno de Render.
const DB_URI = process.env.MONGODB_URI;
if (!DB_URI) {
    console.error("Error: La variable de entorno MONGODB_URI no está definida.");
    process.exit(1);
}
mongoose.connect(DB_URI)
    .then(() => console.log('Conectado a MongoDB Atlas'))
    .catch(err => console.error('Error al conectar a MongoDB:', err));

// Esquema y Modelo para Conversaciones
const conversationSchema = new mongoose.Schema({
    roomId: String,
    participants: [{
        nick: String,
        gender: String,
        isBot: Boolean
    }],
    messages: [{
        nick: String,
        message: String,
        timestamp: { type: Date, default: Date.now }
    }],
    likes: { type: Number, default: 0 },
    spyCount: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true }, // Si la conversación está activa o no
    isBotChat: { type: Boolean, default: false }
}, { timestamps: true });

const Conversation = mongoose.model('Conversation', conversationSchema);


// --- Configuración de la IA (Google Gemini) ---
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY; // Obtenida de variables de entorno de Render
if (!GOOGLE_API_KEY) {
    console.error("Error: La variable de entorno GOOGLE_API_KEY no está definida.");
    process.exit(1);
}
const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-pro" });

// --- Variables Globales del Servidor ---
let waitingUsers = []; // Usuarios esperando chat (humanos)
let activeRooms = {}; // Salas de chat activas { roomId: { users: [{ id, nick, gender, interest }], messages: [], likes, spyCount, isBotChat: false } }
let botRooms = {}; // Salas de chat con bots

// Función para generar un ID de sala único
function generateRoomId() {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// --- Servir archivos estáticos del frontend ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Lógica de Socket.IO ---
io.on('connection', (socket) => {
    console.log('Nuevo usuario conectado:', socket.id);

    // --- Lógica de Chat ---
    socket.on('join_chat', async (userData) => {
        const user = { id: socket.id, ...userData };
        console.log(`Usuario ${user.nick} (${user.gender}) busca chat. Interés: ${user.interest}`);

        // 1. Intentar emparejar con un humano
        let foundPartner = null;
        for (let i = 0; i < waitingUsers.length; i++) {
            const partner = waitingUsers[i];
            // Lógica de emparejamiento: si ambos se interesan en el género del otro
            const matchesGenderInterest = (u1, u2) => {
                const u1_interest_u2_gender = u1.interest === 'cualquiera' || u1.interest === u2.gender;
                const u2_interest_u1_gender = u2.interest === 'cualquiera' || u2.interest === u1.gender;
                return u1_interest_u2_gender && u2_interest_u1_gender;
            };

            if (matchesGenderInterest(user, partner)) {
                foundPartner = partner;
                waitingUsers.splice(i, 1); // Quitar de la lista de espera
                break;
            }
        }

        if (foundPartner) {
            // Emparejamiento humano-humano
            const roomId = generateRoomId();
            activeRooms[roomId] = {
                users: [user, foundPartner],
                messages: [],
                likes: 0,
                spyCount: 0,
                isBotChat: false
            };

            // Guardar conversación en DB
            const newConversation = new Conversation({
                roomId: roomId,
                participants: [
                    { nick: user.nick, gender: user.gender, isBot: false },
                    { nick: foundPartner.nick, gender: foundPartner.gender, isBot: false }
                ]
            });
            await newConversation.save();

            socket.join(roomId);
            io.sockets.sockets.get(foundPartner.id).join(roomId);

            // Notificar a ambos usuarios
            socket.emit('chat_started', {
                roomId: roomId,
                partnerNick: foundPartner.nick,
                partnerGender: foundPartner.gender,
                spyCount: activeRooms[roomId].spyCount,
                likeCount: activeRooms[roomId].likes
            });
            io.to(foundPartner.id).emit('chat_started', {
                roomId: roomId,
                partnerNick: user.nick,
                partnerGender: user.gender,
                spyCount: activeRooms[roomId].spyCount,
                likeCount: activeRooms[roomId].likes
            });
            console.log(`Chat humano-humano iniciado: ${user.nick} y ${foundPartner.nick} en sala ${roomId}`);

        } else {
            // 2. Si no hay humano, añadir a la lista de espera (por si llega alguien) y buscar bot
            waitingUsers.push(user);
            console.log(`${user.nick} añadido a la lista de espera. Total: ${waitingUsers.length}`);

            // Emparejamiento con un bot (simplificado por ahora)
            const roomId = generateRoomId();
            const botName = "ChatBot NewMegle"; // Nombre del bot
            const botGender = "cualquiera"; // Género del bot para emparejamiento

            botRooms[roomId] = {
                users: [user, { id: 'bot-' + roomId, nick: botName, gender: botGender }],
                messages: [],
                likes: 0,
                spyCount: 0,
                isBotChat: true
            };

             // Guardar conversación en DB (marcar como bot)
             const newConversation = new Conversation({
                roomId: roomId,
                participants: [
                    { nick: user.nick, gender: user.gender, isBot: false },
                    { nick: botName, gender: botGender, isBot: true }
                ],
                isBotChat: true
            });
            await newConversation.save();

            socket.join(roomId);
            socket.emit('bot_chat_started', {
                roomId: roomId,
                botName: botName,
                spyCount: botRooms[roomId].spyCount,
                likeCount: botRooms[roomId].likes
            });
            console.log(`Chat con bot iniciado para ${user.nick} en sala ${roomId}`);
        }
    });

    socket.on('chat_message', async (data) => {
        const { roomId, message } = data;
        let room = activeRooms[roomId] || botRooms[roomId];
        if (!room) return;

        const userNick = room.users.find(u => u.id === socket.id)?.nick || 'Desconocido';
        room.messages.push({ nick: userNick, message: message });
        console.log(`Mensaje en sala ${roomId} de ${userNick}: ${message}`);

        // Guardar mensaje en DB
        await Conversation.updateOne(
            { roomId: roomId },
            { $push: { messages: { nick: userNick, message: message } } }
        );

        // Enviar mensaje a todos en la sala (incluidos espías)
        io.to(roomId).emit('chat_message', { nick: userNick, message: message }); // Para los del chat
        io.to(roomId).emit('new_spy_message', { roomId: roomId, nick: userNick, message: message }); // Para los espías


        // Si es un chat con bot, hacer que el bot responda
        if (room.isBotChat) {
            const botUser = room.users.find(u => u.id.startsWith('bot-'));
            if (botUser) {
                try {
                    const result = await model.generateContent(message);
                    const response = await result.response;
                    const botMessage = response.text();

                    room.messages.push({ nick: botUser.nick, message: botMessage });

                    // Guardar mensaje del bot en DB
                    await Conversation.updateOne(
                        { roomId: roomId },
                        { $push: { messages: { nick: botUser.nick, message: botMessage } } }
                    );

                    io.to(roomId).emit('chat_message', { nick: botUser.nick, message: botMessage });
                    io.to(roomId).emit('new_spy_message', { roomId: roomId, nick: botUser.nick, message: botMessage }); // Para los espías
                    console.log(`Respuesta del bot en sala ${roomId}: ${botMessage}`);
                } catch (error) {
                    console.error("Error al generar respuesta de IA:", error);
                    const errorMessage = "Lo siento, tuve un problema para entenderte.";
                    room.messages.push({ nick: botUser.nick, message: errorMessage });
                    await Conversation.updateOne(
                        { roomId: roomId },
                        { $push: { messages: { nick: botUser.nick, message: errorMessage } } }
                    );
                    io.to(roomId).emit('chat_message', { nick: botUser.nick, message: errorMessage });
                     io.to(roomId).emit('new_spy_message', { roomId: roomId, nick: botUser.nick, message: errorMessage });
                }
            }
        }
    });

    socket.on('leave_chat', async (roomId) => {
        let room = activeRooms[roomId] || botRooms[roomId];
        if (!room) return;

        const leavingUserNick = room.users.find(u => u.id === socket.id)?.nick || 'Desconocido';
        console.log(`${leavingUserNick} ha abandonado la sala ${roomId}`);

        // Actualizar estado de la conversación en DB
        await Conversation.updateOne({ roomId: roomId }, { $set: { isActive: false } });

        // Notificar a todos en la sala (incluidos espías)
        io.to(roomId).emit('chat_ended', { reason: `${leavingUserNick} ha abandonado la conversación.` , roomId: roomId});

        // Limpiar la sala y la lista de espera del usuario
        if (activeRooms[roomId]) {
            const otherUser = room.users.find(u => u.id !== socket.id);
            if (otherUser) {
                io.sockets.sockets.get(otherUser.id)?.leave(roomId); // Sacar al otro usuario de la sala
                // Si el otro usuario es humano y se queda solo, ofrecerle buscar de nuevo o bot
                // Por ahora, simplemente se termina para ambos
            }
            delete activeRooms[roomId];
        } else if (botRooms[roomId]) {
            delete botRooms[roomId];
        }

        // Sacar al usuario actual de la sala
        socket.leave(roomId);

        // Quitar al usuario de la lista de espera si estaba ahí
        waitingUsers = waitingUsers.filter(user => user.id !== socket.id);

         // Si el usuario era espía y estaba en esta sala, también se saca
         if (socket.isSpying && socket.spyRoomId === roomId) {
            socket.leave(roomId);
            delete socket.isSpying;
            delete socket.spyRoomId;
            console.log(`${socket.id} ha dejado de espiar la sala ${roomId} por cierre del chat.`);
         }
    });

    // --- Lógica de Espionaje ---
    socket.on('request_spy_conversation', async () => {
        if (socket.isSpying && socket.spyRoomId) { // Si ya estaba espiando una, la deja
            await Conversation.updateOne({ roomId: socket.spyRoomId }, { $inc: { spyCount: -1 } });
            io.to(socket.spyRoomId).emit('update_spy_info', {
                roomId: socket.spyRoomId,
                spyCount: (activeRooms[socket.spyRoomId] || botRooms[socket.spyRoomId])?.spyCount || 0,
                likeCount: (activeRooms[socket.spyRoomId] || botRooms[socket.spyRoomId])?.likes || 0
            });
            socket.leave(socket.spyRoomId);
        }

        // Buscar conversaciones activas con al menos 6 interacciones
        const eligibleConversations = await Conversation.find({
            isActive: true,
            'messages.5': { '$exists': true } // Asegura que hay al menos 6 mensajes (índice 5 es el 6to mensaje)
        });

        if (eligibleConversations.length > 0) {
            // Elige una conversación al azar
            const randomConversation = eligibleConversations[Math.floor(Math.random() * eligibleConversations.length)];
            const roomId = randomConversation.roomId;
            const roomData = activeRooms[roomId] || botRooms[roomId];

            if (roomData) {
                socket.join(roomId);
                socket.isSpying = true;
                socket.spyRoomId = roomId;

                roomData.spyCount = (roomData.spyCount || 0) + 1; // Incrementa el contador de espías en memoria
                await Conversation.updateOne({ roomId: roomId }, { $inc: { spyCount: 1 } }); // También en DB

                // Notificar a todos en la sala (chatters y otros espías) sobre el nuevo espía
                io.to(roomId).emit('update_spy_info', {
                    roomId: roomId,
                    spyCount: roomData.spyCount,
                    likeCount: roomData.likes
                });

                // Enviar el historial de mensajes al espía
                socket.emit('spy_conversation_found', {
                    roomId: roomId,
                    messages: roomData.messages,
                    spyCount: roomData.spyCount,
                    likeCount: roomData.likes
                });
                console.log(`Usuario ${socket.id} espiando sala ${roomId}`);
            } else {
                 // Si la conversación existe en DB pero no en memoria (ej. después de un reinicio del server), buscar otra
                 console.warn(`Conversación ${roomId} encontrada en DB pero no en memoria. Buscando otra.`);
                 socket.emit('no_spy_conversations'); // O pedir que intente de nuevo
            }
        } else {
            socket.emit('no_spy_conversations');
            console.log('No hay conversaciones para espiar en este momento.');
        }
    });

    socket.on('leave_spy_conversation', async (roomId) => {
        if (socket.isSpying && socket.spyRoomId === roomId) {
            let room = activeRooms[roomId] || botRooms[roomId];
            if (room) {
                room.spyCount = Math.max(0, (room.spyCount || 0) - 1); // Decrementa
                await Conversation.updateOne({ roomId: roomId }, { $inc: { spyCount: -1 } }); // También en DB
                io.to(roomId).emit('update_spy_info', {
                    roomId: roomId,
                    spyCount: room.spyCount,
                    likeCount: room.likes
                });
            }
            socket.leave(roomId);
            delete socket.isSpying;
            delete socket.spyRoomId;
            console.log(`${socket.id} ha dejado de espiar la sala ${roomId}`);
        }
    });

    // --- Lógica de Likes ---
    socket.on('send_like', async (roomId) => {
        let room = activeRooms[roomId] || botRooms[roomId];
        if (room) {
            room.likes = (room.likes || 0) + 1; // Incrementa en memoria
            await Conversation.updateOne({ roomId: roomId }, { $inc: { likes: 1 } }); // También en DB

            // Notificar a todos en la sala
            io.to(roomId).emit('update_spy_info', {
                roomId: roomId,
                spyCount: room.spyCount,
                likeCount: room.likes
            });
            console.log(`Like en sala ${roomId}. Total: ${room.likes}`);
        }
    });

    socket.on('disconnect', async () => {
        console.log('Usuario desconectado:', socket.id);

        // Si estaba en chat humano-humano
        let foundRoomId = null;
        for (const roomId in activeRooms) {
            const room = activeRooms[roomId];
            if (room.users.some(u => u.id === socket.id)) {
                foundRoomId = roomId;
                break;
            }
        }

        if (foundRoomId) {
            const room = activeRooms[foundRoomId];
            const leavingUserNick = room.users.find(u => u.id === socket.id)?.nick || 'Desconocido';

            // Notificar a todos en la sala (incluidos espías)
            io.to(foundRoomId).emit('chat_ended', { reason: `${leavingUserNick} se ha desconectado.`, roomId: foundRoomId });

            // Marcar conversación como inactiva en DB
            await Conversation.updateOne({ roomId: foundRoomId }, { $set: { isActive: false } });

            // Limpiar la sala
            const otherUser = room.users.find(u => u.id !== socket.id);
            if (otherUser) {
                io.sockets.sockets.get(otherUser.id)?.leave(foundRoomId);
            }
            delete activeRooms[foundRoomId];
        }

        // Si estaba en chat con bot
        let foundBotRoomId = null;
        for (const roomId in botRooms) {
            const room = botRooms[roomId];
            if (room.users.some(u => u.id === socket.id)) {
                foundBotRoomId = roomId;
                break;
            }
        }
        if (foundBotRoomId) {
            const room = botRooms[foundBotRoomId];
            const leavingUserNick = room.users.find(u => u.id === socket.id)?.nick || 'Desconocido';

            io.to(foundBotRoomId).emit('chat_ended', { reason: `${leavingUserNick} se ha desconectado.`, roomId: foundBotRoomId });
            await Conversation.updateOne({ roomId: foundBotRoomId }, { $set: { isActive: false } });
            delete botRooms[foundBotRoomId];
        }

        // Quitar de la lista de espera si estaba ahí
        waitingUsers = waitingUsers.filter(user => user.id !== socket.id);

        // Si el usuario era espía, manejar su salida
        if (socket.isSpying && socket.spyRoomId) {
            let room = activeRooms[socket.spyRoomId] || botRooms[socket.spyRoomId];
            if (room) {
                room.spyCount = Math.max(0, (room.spyCount || 0) - 1);
                await Conversation.updateOne({ roomId: socket.spyRoomId }, { $inc: { spyCount: -1 } });
                io.to(socket.spyRoomId).emit('update_spy_info', {
                    roomId: socket.spyRoomId,
                    spyCount: room.spyCount,
                    likeCount: room.likes
                });
            }
            socket.leave(socket.spyRoomId);
            delete socket.isSpying;
            delete socket.spyRoomId;
            console.log(`${socket.id} ha dejado de espiar por desconexión.`);
        }
    });
});

// --- Iniciar el Servidor ---
server.listen(PORT, () => {
    console.log(`Servidor NewMegle escuchando en el puerto ${PORT}`);
});
