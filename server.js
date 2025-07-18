const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const { createId } = require('@paralleldrive/cuid2');

const app = express();
const PORT = 3001;
const prisma = new PrismaClient();

// Middleware
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:3001'], // Include both frontend and backend
  credentials: true
}));
app.use(express.json());

// Store connected SSE clients
let clients = [];

// SSE endpoint - clients connect here to receive real-time updates
app.get('/events', (req, res) => {
  // Set headers for SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Credentials': 'true'
  });

  // Send initial connection message
  res.write(`data: ${JSON.stringify({ 
    type: 'connection', 
    message: 'Connected to SSE stream',
    timestamp: new Date().toISOString()
  })}\n\n`);

  // Add client to the list
  const clientId = Date.now();
  const client = {
    id: clientId,
    response: res,
    userId: req.query.userId || null // Allow filtering by user
  };
  clients.push(client);

  console.log(`Client ${clientId} connected. Total clients: ${clients.length}`);

  // Handle client disconnect
  req.on('close', () => {
    clients = clients.filter(c => c.id !== clientId);
    console.log(`Client ${clientId} disconnected. Total clients: ${clients.length}`);
  });

  // Keep connection alive with periodic heartbeat
  const heartbeat = setInterval(() => {
    res.write(`data: ${JSON.stringify({ 
      type: 'heartbeat', 
      timestamp: new Date().toISOString()
    })}\n\n`);
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
  });
});

// Function to broadcast to specific user or all users
function broadcastToUser(userId, data, messageType = 'reservation') {
  const message = {
    type: messageType,
    data: data,
    timestamp: new Date().toISOString(),
    userId: userId
  };

  let sentCount = 0;
  clients.forEach(client => {
    try {
      // Send to specific user or to all if no user filter
      if (!client.userId || client.userId === userId) {
        client.response.write(`data: ${JSON.stringify(message)}\n\n`);
        sentCount++;
      }
    } catch (error) {
      console.error('Error sending to client:', error);
    }
  });

  console.log(`Broadcasted to ${sentCount} clients for user ${userId}`);
  return sentCount > 0;
}

// AI Agent reservation endpoint - handles booking creation with database storage
app.post('/ai/reservation/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const {
      customerName,
      phone,
      partySize,
      bookingDate,
      time,
      note,
      customerEmail
    } = req.body;

    console.log(`📞 AI Reservation request for user ${userId}:`, req.body);

    // Validate required fields
    if (!customerName || !phone || !partySize || !bookingDate || !time) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: customerName, phone, partySize, bookingDate, time',
        received: { customerName, phone, partySize, bookingDate, time }
      });
    }

    // Validate party size
    if (partySize < 1 || partySize > 20) {
      return res.status(400).json({
        success: false,
        message: 'Party size must be between 1 and 20',
        received: partySize
      });
    }

    // Validate and correct date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    let correctedDate = bookingDate;
    
    if (!dateRegex.test(bookingDate)) {
      try {
        const parsedDate = new Date(bookingDate);
        if (!isNaN(parsedDate.getTime())) {
          correctedDate = parsedDate.toISOString().split('T')[0];
        }
      } catch (e) {
        return res.status(400).json({
          success: false,
          message: 'Invalid date format. Use YYYY-MM-DD',
          received: bookingDate,
          expected: 'YYYY-MM-DD (e.g., 2024-12-25)'
        });
      }
    }

    // Validate and correct time format
    const timeRegex = /^([01]?\d|2[0-3]):[0-5]\d$/;
    let correctedTime = time;
    
    if (!timeRegex.test(time)) {
      // Try to convert 12-hour format to 24-hour format
      const time12HourRegex = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i;
      const match = time.match(time12HourRegex);
      
      if (match) {
        let [, hours, minutes, ampm] = match;
        let hour24 = parseInt(hours);
        
        if (ampm.toUpperCase() === 'PM' && hour24 !== 12) {
          hour24 += 12;
        } else if (ampm.toUpperCase() === 'AM' && hour24 === 12) {
          hour24 = 0;
        }
        
        correctedTime = `${hour24.toString().padStart(2, '0')}:${minutes}`;
      } else {
        return res.status(400).json({
          success: false,
          message: 'Invalid time format. Use HH:MM (24-hour format) or HH:MM AM/PM',
          received: time,
          expected: '14:30 or 2:30 PM'
        });
      }
    }

    // Clean and validate phone number
    let cleanPhone = phone.replace(/[\s\-\(\)\.]/g, '');
    const phoneRegex = /^[\+]?[1-9][\d]{0,15}$/;
    
    if (!phoneRegex.test(cleanPhone)) {
      if (cleanPhone.startsWith('0')) {
        cleanPhone = cleanPhone.substring(1);
      }
      
      if (!phoneRegex.test(cleanPhone)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid phone number format',
          received: phone,
          cleaned: cleanPhone,
          expected: 'International format without leading zeros'
        });
      }
    }

    // Verify user exists
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { settings: true }
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Create date/time objects
    const startDateTime = new Date(`${correctedDate}T${correctedTime}:00`);
    const now = new Date();
    
    // Check if reservation is not in the past
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    if (startDateTime <= fiveMinutesAgo) {
      return res.status(400).json({
        success: false,
        message: 'Cannot make reservations for past dates and times',
        requestedTime: startDateTime.toISOString(),
        currentTime: now.toISOString()
      });
    }

    // Calculate end time (2 hours later)
    const endDateTime = new Date(startDateTime.getTime() + (2 * 60 * 60 * 1000));

    // Generate booking ID and title
    const bookingId = createId();
    const title = `${customerName.trim()} - Party of ${partySize}`;

    // Save to database
    const booking = await prisma.bookings.create({
      data: {
        id: bookingId,
        user_id: userId,
        title: title,
        start_time: startDateTime,
        end_time: endDateTime,
        status: 'confirmed',
        color: '#3b82f6',
        party_size: partySize.toString(),
        notes: note?.trim() || null,
        customer_name: customerName.trim(),
        customer_email: customerEmail?.trim() || null,
        customer_phone: cleanPhone,
        created_at: new Date(),
        updated_at: new Date()
      }
    });

    console.log(`✅ Booking created in database: ${bookingId}`);

    // Create reservation object for frontend
    const reservation = {
      id: booking.id,
      title: booking.title,
      start: booking.start_time,
      end: booking.end_time,
      status: booking.status,
      color: booking.color,
      name: booking.customer_name,
      email: booking.customer_email,
      phone: booking.customer_phone,
      partySize: parseInt(booking.party_size || '0'),
      notes: booking.notes,
      formattedDate: formatDate(correctedDate),
      formattedTime: formatTime(correctedTime),
      createdAt: booking.created_at
    };

    // Broadcast to SSE clients
    const broadcastSuccess = broadcastToUser(userId, reservation, 'new_reservation');

    const businessName = user.settings?.businessName || 'our restaurant';
    const responseMessage = `Perfect! I've successfully booked your reservation at ${businessName} for ${partySize} ${partySize === 1 ? 'person' : 'people'} on ${formatDate(correctedDate)} at ${formatTime(correctedTime)}. Your confirmation number is ${bookingId}. ${note ? `I've noted: ${note}.` : ''} We look forward to seeing you!`;

    res.json({
      success: true,
      message: responseMessage,
      data: reservation,
      bookingId: bookingId,
      businessName: businessName,
      sseNotified: broadcastSuccess
    });

  } catch (error) {
    console.error('❌ AI Reservation Error:', error);
    
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    
    // Handle Prisma errors
    if (error && typeof error === 'object' && 'code' in error) {
      const prismaError = error;
      
      if (prismaError.code === 'P2002') {
        return res.status(409).json({
          success: false,
          message: 'A booking with this ID already exists. Please try again.',
        });
      }
      
      if (prismaError.code === 'P2003') {
        return res.status(400).json({
          success: false,
          message: 'Invalid user ID provided.',
        });
      }
    }
    
    res.status(500).json({
      success: false,
      message: 'Failed to create reservation. Please try again.',
      error: process.env.NODE_ENV === 'development' ? errorMessage : 'Internal server error'
    });
  }
});

// Get reservations for a user
app.get('/api/reservations/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const bookings = await prisma.bookings.findMany({
      where: { user_id: userId },
      orderBy: { start_time: 'desc' }
    });

    const reservations = bookings.map(booking => ({
      id: booking.id,
      title: booking.title,
      start: booking.start_time,
      end: booking.end_time,
      status: booking.status,
      color: booking.color,
      name: booking.customer_name,
      email: booking.customer_email,
      phone: booking.customer_phone,
      partySize: parseInt(booking.party_size || '0'),
      notes: booking.notes,
      createdAt: booking.created_at
    }));

    res.json({
      success: true,
      data: reservations,
      count: reservations.length
    });

  } catch (error) {
    console.error('Error fetching reservations:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch reservations'
    });
  }
});

// Simple POST endpoint for testing (keeps existing functionality)
app.post('/message', (req, res) => {
  const { message, data, userId } = req.body;
  
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  const eventData = {
    type: 'message',
    message,
    data: data || null,
    timestamp: new Date().toISOString(),
    source: 'curl'
  };

  console.log('Broadcasting message to clients:', eventData);

  // Broadcast to specific user or all users
  const targetUserId = userId || null;
  let sentCount = 0;
  
  clients.forEach(client => {
    try {
      if (!targetUserId || !client.userId || client.userId === targetUserId) {
        client.response.write(`data: ${JSON.stringify(eventData)}\n\n`);
        sentCount++;
      }
    } catch (error) {
      console.error('Error sending to client:', error);
    }
  });

  res.json({ 
    success: true, 
    message: 'Message broadcasted',
    clientCount: sentCount,
    data: eventData
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    clients: clients.length,
    timestamp: new Date().toISOString(),
    database: 'connected'
  });
});

// Helper functions
function formatDate(dateString) {
  const date = new Date(dateString);
  const options = { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  };
  return date.toLocaleDateString('en-US', options);
}

function formatTime(timeString) {
  const [hours, minutes] = timeString.split(':');
  const hour24 = parseInt(hours);
  const hour12 = hour24 === 0 ? 12 : hour24 > 12 ? hour24 - 12 : hour24;
  const ampm = hour24 >= 12 ? 'PM' : 'AM';
  return `${hour12}:${minutes} ${ampm}`;
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🔄 Gracefully shutting down...');
  await prisma.$disconnect();
  process.exit(0);
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 SSE Server with Database running on http://localhost:${PORT}`);
 
});