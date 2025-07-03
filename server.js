const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const mongoose = require('mongoose');
require('dotenv').config(); // Cargar variables de entorno del archivo .env

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*", // Permite cualquier origen para desarrollo
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 10000; // Render usará el puerto 10000

// --- Configuración de la Base de Datos (MongoDB) ---
const DB_URI = process.env.MONGODB_URI;
if (!DB_URI) {
    console.error("Error: La variable de entorno MONGODB_URI no está definida. Asegúrate de configurarla en Render.");
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
        gender: String, // 'masculino', 'femenino', 'cualquiera'
        isBot: { type: Boolean, default: false }
    }],
    messages: [{
        nick: String,
        message: String,
        timestamp: { type: Date, default: Date.now }
    }],
    likes: { type: Number, default: 0 },
    spyCount: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true }, // Si la conversación está activa o no (para espiar)
    isBotChat: { type: Boolean, default: false }
}, { timestamps: true });

const Conversation = mongoose.model('Conversation', conversationSchema);

// --- Configuración de la IA (Google Gemini) ---
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
if (!GOOGLE_API_KEY) {
    console.error("Error: La variable de entorno GOOGLE_API_KEY no está definida. Asegúrate de configurarla en Render y que sea válida.");
    process.exit(1);
}
const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-pro" });

// --- Variables Globales del Servidor ---
let waitingUsers = []; // Usuarios esperando chat (humanos)
let activeRooms = {}; // Salas de chat activas { roomId: { users: [{ id, nick, gender, interest }], messages: [], likes, spyCount, isBotChat } }

// Función para generar un ID de sala único
function generateRoomId() {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Función para obtener nombres aleatorios
const maleNames = ["Alejandro", "Carlos", "Diego", "Felipe", "Gabriel", "Hugo", "Iván", "Javier", "Luis", "Mateo", "Pablo", "Ricardo"];
const femaleNames = ["Ana", "Brenda", "Carla", "Daniela", "Elena", "Fernanda", "Gabriela", "Isabel", "Julia", "Laura", "María", "Sofía"];

function getRandomName(genderType) {
    if (genderType === 'masculino') {
        return maleNames[Math.floor(Math.random() * maleNames.length)];
    } else if (genderType === 'femenino') {
        return femaleNames[Math.floor(Math.random() * femaleNames.length)];
    }
    return "Compañero Anónimo"; // Fallback, no debería usarse
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

        // 1. Quitar al usuario de la lista de espera si ya estaba por alguna razón
        waitingUsers = waitingUsers.filter(u => u.id !== user.id);

        // 2. Intentar emparejar con un humano
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
            // 3. Si no hay humano, añadir a la lista de espera y luego buscar bot inmediatamente (o en X segundos si quisiéramos)
            waitingUsers.push(user);
            console.log(`${user.nick} añadido a la lista de espera. Total: ${waitingUsers.length}`);

            // Emparejamiento con un bot
            const roomId = generateRoomId();

            let botNick, botGender;
            // Asignar nombre y género al bot según el interés del usuario
            if (user.interest === 'masculino') { // Usuario busca masculino, bot es masculino
                botNick = getRandomName('masculino');
                botGender = 'masculino';
            } else if (user.interest === 'femenino') { // Usuario busca femenino, bot es femenino
                botNick = getRandomName('femenino');
                botGender = 'femenino';
            } else { // Usuario busca 'cualquiera', bot puede ser masculino o femenino al azar
                const randomGender = Math.random() < 0.5 ? 'masculino' : 'femenino';
                botNick = getRandomName(randomGender);
                botGender = randomGender;
            }

            // Crear la sala del bot en activeRooms (simplificando la gestión de salas)
            activeRooms[roomId] = {
                users: [user, { id: 'bot-' + roomId, nick: botNick, gender: botGender, isBot: true }],
                messages: [],
                likes: 0,
                spyCount: 0,
                isBotChat: true
            };

            // Quitar al usuario de la lista de espera si se le asignó un bot
            waitingUsers = waitingUsers.filter(u => u.id !== user.id);

            // Guardar conversación en DB (marcar como bot)
            const newConversation = new Conversation({
                roomId: roomId,
                participants: [
                    { nick: user.nick, gender: user.gender, isBot: false },
                    { nick: botNick, gender: botGender, isBot: true }
                ],
                isBotChat: true
            });
            await newConversation.save();

            socket.join(roomId);
            socket.emit('bot_chat_started', {
                roomId: roomId,
                botNick: botNick, // Enviar el nick real del bot
                botGender: botGender, // Enviar el género real del bot
                spyCount: activeRooms[roomId].spyCount,
                likeCount: activeRooms[roomId].likes
            });
            console.log(`Chat con bot iniciado para ${user.nick} con ${botNick} en sala ${roomId}`);
        }
    });

    socket.on('chat_message', async (data) => {
        const { roomId, message } = data;
        let room = activeRooms[roomId];
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
        io.to(roomId).emit('chat_message', { roomId: roomId, nick: userNick, message: message }); // Para los del chat
        io.to(roomId).emit('new_spy_message', { roomId: roomId, nick: userNick, message: message }); // Para los espías


        // Si es un chat con bot, hacer que el bot responda
        if (room.isBotChat) {
            const botUser = room.users.find(u => u.isBot); // Encuentra el participante que es bot
            if (botUser) {
                // Añadir un retraso para simular un tiempo de respuesta humano (2 a 5 segundos)
                const delay = Math.floor(Math.random() * 3000) + 2000; // 2000ms (2s) a 5000ms (5s)
                await new Promise(resolve => setTimeout(resolve, delay));

                try {
                    // Historial para mantener el contexto con el bot
                    const chatHistory = room.messages.map(msg => ({
                        role: msg.nick === botUser.nick ? "model" : "user",
                        parts: [{ text: msg.message }]
                    }));

                    const chat = model.startChat({ history: chatHistory });
                    const result = await chat.sendMessage(message);
                    const response = await result.response;
                    const botMessage = response.text();

                    room.messages.push({ nick: botUser.nick, message: botMessage });

                    // Guardar mensaje del bot en DB
                    await Conversation.updateOne(
                        { roomId: roomId },
                        { $push: { messages: { nick: botUser.nick, message: botMessage } } }
                    );

                    io.to(roomId).emit('chat_message', { roomId: roomId, nick: botUser.nick, message: botMessage });
                    io.to(roomId).emit('new_spy_message', { roomId: roomId, nick: botUser.nick, message: botMessage });
                    console.log(`Respuesta del bot en sala ${roomId}: ${botMessage}`);
                } catch (error) {
                    console.error("Error al generar respuesta de IA (verificar API Key y configuración de Gemini):", error);
                    const errorMessage = "Lo siento, parece que hay un pequeño problema en mi cerebro. ¿Podrías intentar otra pregunta?";
                    room.messages.push({ nick: botUser.nick, message: errorMessage });
                    await Conversation.updateOne(
                        { roomId: roomId },
                        { $push: { messages: { nick: botUser.nick, message: errorMessage } } }
                    );
                    io.to(roomId).emit('chat_message', { roomId: roomId, nick: botUser.nick, message: errorMessage });
                    io.to(roomId).emit('new_spy_message', { roomId: roomId, nick: botUser.nick, message: errorMessage });
                }
            }
        }
    });

    socket.on('leave_chat', async (roomId) => {
        let room = activeRooms[roomId];
        if (!room) {
            console.log(`Intento de salir de chat en sala ${roomId} que no existe o ya inactiva.`);
            return;
        }

        const leavingUserNick = room.users.find(u => u.id === socket.id)?.nick || 'Desconocido';
        console.log(`${leavingUserNick} ha abandonado la sala ${roomId}`);

        // Marcar conversación como inactiva en DB
        await Conversation.updateOne({ roomId: roomId }, { $set: { isActive: false } });

        // Notificar a todos en la sala (incluidos espías)
        io.to(roomId).emit('chat_ended', { reason: `${leavingUserNick} ha abandonado la conversación.` , roomId: roomId});

        // Limpiar la sala y sacar usuarios
        if (room.isBotChat) {
             // Si es chat con bot, simplemente eliminar la sala
            delete activeRooms[roomId];
        } else {
            // Si es chat humano-humano, sacar al otro usuario también
            const otherUser = room.users.find(u => u.id !== socket.id);
            if (otherUser) {
                io.sockets.sockets.get(otherUser.id)?.leave(roomId);
            }
            delete activeRooms[roomId];
        }
        socket.leave(roomId); // Sacar al usuario que envió el leave_chat

        // Quitar al usuario de la lista de espera si estaba ahí
        waitingUsers = waitingUsers.filter(user => user.id !== socket.id);

        // Si el usuario que salió era espía de otra sala, su estado de espía ya se maneja en 'disconnect'
    });

    // --- Lógica de Espionaje ---
    socket.on('request_spy_conversation', async () => {
        // Si el espía ya estaba espiando una, se debe "desuscribir" de ella antes de buscar otra
        if (socket.currentSpyRoomId) {
            let oldRoom = activeRooms[socket.currentSpyRoomId];
            if (oldRoom) {
                oldRoom.spyCount = Math.max(0, (oldRoom.spyCount || 0) - 1); // Decrementa el contador
                await Conversation.updateOne({ roomId: socket.currentSpyRoomId }, { $inc: { spyCount: -1 } });
                io.to(socket.currentSpyRoomId).emit('update_spy_info', {
                    roomId: socket.currentSpyRoomId,
                    spyCount: oldRoom.spyCount,
                    likeCount: oldRoom.likes
                });
            }
            socket.leave(socket.currentSpyRoomId);
            delete socket.currentSpyRoomId;
            console.log(`${socket.id} ha dejado de espiar la sala anterior.`);
        }

        // Buscar conversaciones activas
        // Ahora sí, requerimos al menos 6 mensajes para espiar una conversación interesante
        const eligibleConversations = await Conversation.find({
            isActive: true,
            'messages.5': { '$exists': true } // Asegura que hay al menos 6 mensajes (índice 5 es el 6to mensaje)
        });

        if (eligibleConversations.length > 0) {
            // Filtra solo las que están en memoria (activeRooms) para asegurar que aún están "vivas"
            const inMemoryEligibleConversations = eligibleConversations.filter(dbConv => activeRooms[dbConv.roomId]);

            if (inMemoryEligibleConversations.length > 0) {
                const randomConversation = inMemoryEligibleConversations[Math.floor(Math.random() * inMemoryEligibleConversations.length)];
                const roomId = randomConversation.roomId;
                const roomData = activeRooms[roomId]; // Obtener la referencia de la sala en memoria

                if (roomData) { // Doble verificación por si acaso
                    socket.join(roomId);
                    socket.currentSpyRoomId = roomId; // Almacena la sala que está espiando

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
                     // Esto no debería ocurrir si filtramos correctamente, pero es una salvaguarda
                    socket.emit('no_spy_conversations');
                    console.log('No hay conversaciones activas para espiar en memoria.');
                }
            } else {
                socket.emit('no_spy_conversations');
                console.log('No hay conversaciones activas en memoria para espiar.');
            }
        } else {
            socket.emit('no_spy_conversations');
            console.log('No hay conversaciones con suficientes mensajes para espiar en este momento.');
        }
    });

    socket.on('leave_spy_conversation', async (roomId) => {
        if (socket.currentSpyRoomId === roomId) { // Asegura que el usuario estaba espiando esta sala
            let room = activeRooms[roomId];
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
            delete socket.currentSpyRoomId; // Limpiar el estado de espionaje del socket
            console.log(`${socket.id} ha dejado de espiar la sala ${roomId}`);
        }
    });

    // --- Lógica de Likes ---
    socket.on('send_like', async (roomId) => {
        let room = activeRooms[roomId];
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
        console.log('Usuario desconectado:',
