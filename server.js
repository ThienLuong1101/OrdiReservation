const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const { createId } = require('@paralleldrive/cuid2');

const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const { createId } = require('@paralleldrive/cuid2');

const app = express();
const PORT = process.env.PORT || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';

console.log('🔄 Starting server initialization...');
console.log('📊 Node.js version:', process.version);
console.log('📊 Environment variables:');
console.log('  - NODE_ENV:', NODE_ENV);
console.log('  - PORT:', PORT);
console.log('  - DATABASE_URL:', process.env.DATABASE_URL ? 'SET' : 'NOT SET');

// Environment validation
const requiredEnvVars = [];
if (NODE_ENV === 'production') {
  requiredEnvVars.push('DATABASE_URL');
}
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  console.error('❌ Missing required environment variables:', missingEnvVars);
  process.exit(1);
}

// Initialize Prisma with optimized settings for production
const prisma = new PrismaClient({
  log: NODE_ENV === 'development' ? ['query', 'info', 'warn', 'error'] : ['error'],
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
  // Production optimizations
  ...(NODE_ENV === 'production' && {
    __internal: {
      engine: {
        enableEngineDebugMode: false,
      },
    },
  }),
});

// Production-ready CORS configuration
const allowedOrigins = NODE_ENV === 'production' 
  ? (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',').filter(Boolean)
  : ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:5173'];

console.log(`🌐 CORS allowed origins:`, allowedOrigins);

// Security and performance middleware
app.set('trust proxy', 1); // Trust first proxy (for Railway, Render, etc.)
app.disable('x-powered-by'); // Remove Express signature

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  maxAge: 86400 // Cache preflight for 24 hours
}));

app.use(express.json({ 
  limit: '10mb',
  strict: true
}));

// Request timeout middleware
app.use((req, res, next) => {
  res.setTimeout(30000, () => {
    console.error('Request timeout:', req.method, req.path);
    res.status(408).json({ success: false, message: 'Request timeout' });
  });
  next();
});

// Request logging middleware (optimized for production)
if (NODE_ENV === 'development') {
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
  });
}

// Store connected SSE clients with cleanup
let clients = new Map();
let clientCounter = 0;

// Cleanup dead connections every 5 minutes
setInterval(() => {
  const deadClients = [];
  const now = Date.now();
  
  clients.forEach((client, id) => {
    try {
      // Check if response is destroyed or ended
      if (client.response.destroyed || client.response.writableEnded) {
        deadClients.push(id);
        return;
      }
      
      // Check if connection is too old (over 2 hours without activity)
      const connectionAge = now - client.connectedAt.getTime();
      if (connectionAge > 2 * 60 * 60 * 1000) {
        deadClients.push(id);
        try {
          client.response.end();
        } catch (error) {
          // Connection already closed
        }
      }
    } catch (error) {
      deadClients.push(id);
    }
  });
  
  deadClients.forEach(id => {
    clients.delete(id);
  });
  
  if (deadClients.length > 0) {
    console.log(`🧹 Cleaned up ${deadClients.length} dead SSE connections. Active: ${clients.size}`);
  }
}, 5 * 60 * 1000);

// SSE endpoint - optimized for production
app.get('/events', (req, res) => {
  try {
    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'true',
      'X-Accel-Buffering': 'no', // Nginx compatibility
    });

    // Send initial connection message
    res.write(`data: ${JSON.stringify({ 
      type: 'connection', 
      message: 'Connected to SSE stream',
      timestamp: new Date().toISOString()
    })}\n\n`);

    // Add client to the map
    const clientId = ++clientCounter;
    const client = {
      id: clientId,
      response: res,
      userId: req.query.userId || null,
      connectedAt: new Date()
    };
    clients.set(clientId, client);

    console.log(`📡 Client ${clientId} connected. Total: ${clients.size}`);

    // Handle client disconnect
    const cleanup = () => {
      clients.delete(clientId);
      console.log(`📡 Client ${clientId} disconnected. Total: ${clients.size}`);
    };

    req.on('close', cleanup);
    req.on('error', (error) => {
      console.error(`SSE client ${clientId} error:`, error.message);
      cleanup();
    });

    // Heartbeat every 30 seconds
    const heartbeat = setInterval(() => {
      try {
        res.write(`data: ${JSON.stringify({ 
          type: 'heartbeat', 
          timestamp: new Date().toISOString()
        })}\n\n`);
      } catch (error) {
        clearInterval(heartbeat);
        cleanup();
      }
    }, 30000);

    req.on('close', () => {
      clearInterval(heartbeat);
    });

  } catch (error) {
    console.error('SSE setup error:', error);
    res.status(500).end();
  }
});

// Optimized broadcast function
function broadcastToUser(userId, data, messageType = 'reservation') {
  const message = {
    type: messageType,
    data: data,
    timestamp: new Date().toISOString(),
    userId: userId
  };

  let sentCount = 0;
  const messageStr = `data: ${JSON.stringify(message)}\n\n`;
  const deadClients = [];

  clients.forEach((client, id) => {
    try {
      // Send to specific user or to all if no user filter
      if (!client.userId || client.userId === userId) {
        // Check if response is still writable
        if (client.response.destroyed || client.response.writableEnded) {
          deadClients.push(id);
          return;
        }
        
        client.response.write(messageStr);
        sentCount++;
      }
    } catch (error) {
      console.error(`❌ Error sending to client ${id}:`, error.message);
      deadClients.push(id);
    }
  });

  // Remove dead clients
  deadClients.forEach(id => {
    clients.delete(id);
  });

  console.log(`📢 Broadcasted to ${sentCount}/${clients.size} clients for user ${userId}${deadClients.length > 0 ? ` (removed ${deadClients.length} dead clients)` : ''}`);
  return sentCount > 0;
}

// AI Agent reservation endpoint - production optimized
app.post('/ai/reservation/:userId', async (req, res) => {
  const startTime = Date.now();
  
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

    console.log(`📞 AI Reservation for user ${userId}:`, {
      customerName: customerName?.substring(0, 20) + '...',
      phone: phone ? '***-***-' + phone.slice(-4) : 'N/A',
      partySize,
      bookingDate,
      time
    });

    // Validate required fields
    if (!customerName?.trim() || !phone?.trim() || !partySize || !bookingDate || !time) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: customerName, phone, partySize, bookingDate, time'
      });
    }

    // Validate party size
    const parsedPartySize = parseInt(partySize);
    if (isNaN(parsedPartySize) || parsedPartySize < 1 || parsedPartySize > 20) {
      return res.status(400).json({
        success: false,
        message: 'Party size must be a number between 1 and 20'
      });
    }

    // Validate and normalize date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    let correctedDate = bookingDate.trim();
    
    if (!dateRegex.test(correctedDate)) {
      try {
        const parsedDate = new Date(correctedDate);
        if (isNaN(parsedDate.getTime())) {
          throw new Error('Invalid date');
        }
        correctedDate = parsedDate.toISOString().split('T')[0];
      } catch (e) {
        return res.status(400).json({
          success: false,
          message: 'Invalid date format. Use YYYY-MM-DD (e.g., 2025-08-01)'
        });
      }
    }

    // Validate and normalize time format
    const timeRegex = /^([01]?\d|2[0-3]):[0-5]\d$/;
    let correctedTime = time.trim();
    
    if (!timeRegex.test(correctedTime)) {
      // Try to convert 12-hour format to 24-hour format
      const time12HourRegex = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i;
      const match = correctedTime.match(time12HourRegex);
      
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
          message: 'Invalid time format. Use HH:MM (24-hour) or HH:MM AM/PM'
        });
      }
    }

    // Clean and validate phone number
    let cleanPhone = phone.replace(/[\s\-\(\)\.]/g, '');
    const phoneRegex = /^[\+]?[1-9][\d]{7,15}$/;
    
    if (!phoneRegex.test(cleanPhone)) {
      if (cleanPhone.startsWith('0')) {
        cleanPhone = cleanPhone.substring(1);
      }
      
      if (!phoneRegex.test(cleanPhone)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid phone number format'
        });
      }
    }

    // Verify user exists (with timeout)
    const userPromise = prisma.user.findUnique({
      where: { id: userId },
      include: { settings: true }
    });
    
    const user = await Promise.race([
      userPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Database timeout')), 5000))
    ]);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Create and validate date/time objects
    const startDateTime = new Date(`${correctedDate}T${correctedTime}:00.000Z`);
    const now = new Date();
    
    // Check if reservation is not in the past (with 5-minute grace period)
    const gracePeriod = new Date(now.getTime() - 5 * 60 * 1000);
    if (startDateTime <= gracePeriod) {
      return res.status(400).json({
        success: false,
        message: 'Cannot make reservations for past dates and times'
      });
    }

    // Calculate end time (2 hours later)
    const endDateTime = new Date(startDateTime.getTime() + (2 * 60 * 60 * 1000));

    // Generate booking ID and title
    const bookingId = createId();
    const title = `${customerName.trim()} - Party of ${parsedPartySize}`;

    // Save to database with transaction
    const booking = await prisma.bookings.create({
      data: {
        id: bookingId,
        user_id: userId,
        title: title,
        start_time: startDateTime,
        end_time: endDateTime,
        status: 'confirmed',
        color: '#3b82f6',
        party_size: parsedPartySize.toString(),
        notes: note?.trim() || null,
        customer_name: customerName.trim(),
        customer_email: customerEmail?.trim() || null,
        customer_phone: cleanPhone,
        created_at: new Date(),
        updated_at: new Date()
      }
    });

    const processingTime = Date.now() - startTime;
    console.log(`✅ Booking created: ${bookingId} (${processingTime}ms)`);

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

    // Broadcast to SSE clients (non-blocking)
    setImmediate(() => {
      broadcastToUser(userId, reservation, 'new_reservation');
    });

    const businessName = user.settings?.businessName || 'our restaurant';
    const responseMessage = `Perfect! I've successfully booked your reservation at ${businessName} for ${parsedPartySize} ${parsedPartySize === 1 ? 'person' : 'people'} on ${formatDate(correctedDate)} at ${formatTime(correctedTime)}. Your confirmation number is ${bookingId}. ${note ? `I've noted: ${note}.` : ''} We look forward to seeing you!`;

    res.json({
      success: true,
      message: responseMessage,
      data: reservation,
      bookingId: bookingId,
      businessName: businessName,
      processingTime: processingTime
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error(`❌ AI Reservation Error (${processingTime}ms):`, error);
    
    // Handle specific Prisma errors
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

      if (prismaError.code === 'P1001') {
        return res.status(503).json({
          success: false,
          message: 'Database connection failed. Please try again.',
        });
      }
    }
    
    res.status(500).json({
      success: false,
      message: 'Failed to create reservation. Please try again.',
      ...(NODE_ENV === 'development' && { error: error.message })
    });
  }
});

// Get reservations for a user - with caching headers
app.get('/api/reservations/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 100, offset = 0 } = req.query;
    
    // Set caching headers
    res.set({
      'Cache-Control': 'private, max-age=60', // Cache for 1 minute
      'ETag': `"reservations-${userId}-${Date.now()}"`
    });
    
    const bookings = await prisma.bookings.findMany({
      where: { user_id: userId },
      orderBy: { start_time: 'desc' },
      take: parseInt(limit),
      skip: parseInt(offset)
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
      count: reservations.length,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: reservations.length === parseInt(limit)
      }
    });

  } catch (error) {
    console.error('Error fetching reservations:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch reservations'
    });
  }
});

// Message broadcast endpoint - rate limited
const messageRateLimit = new Map();
app.post('/message', (req, res) => {
  try {
    const clientIP = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    
    // Simple rate limiting: 10 messages per minute per IP
    const key = `msg_${clientIP}`;
    const requests = messageRateLimit.get(key) || [];
    const recentRequests = requests.filter(time => now - time < 60000);
    
    if (recentRequests.length >= 10) {
      return res.status(429).json({
        success: false,
        message: 'Rate limit exceeded. Max 10 messages per minute.'
      });
    }
    
    recentRequests.push(now);
    messageRateLimit.set(key, recentRequests);
    
    const { message, data, userId } = req.body;
    
    if (!message?.trim()) {
      return res.status(400).json({ 
        success: false,
        error: 'Message is required and cannot be empty'
      });
    }

    const eventData = {
      type: 'message',
      message: message.trim(),
      data: data || null,
      timestamp: new Date().toISOString(),
      source: 'api'
    };

    console.log('📢 Broadcasting message:', { 
      preview: message.substring(0, 50) + (message.length > 50 ? '...' : ''),
      userId: userId || 'all',
      clients: clients.size
    });

    // Broadcast to specific user or all users
    const sentCount = broadcastToUser(userId || null, eventData, 'message');

    res.json({ 
      success: true, 
      message: 'Message broadcasted',
      clientCount: sentCount,
      totalClients: clients.size
    });
  } catch (error) {
    console.error('Error broadcasting message:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to broadcast message'
    });
  }
});

// Enhanced health check endpoint
app.get('/health', async (req, res) => {
  const startTime = Date.now();
  
  try {
    // Test database connection with timeout
    const dbPromise = prisma.$queryRaw`SELECT 1 as health`;
    const dbResult = await Promise.race([
      dbPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), 3000))
    ]);
    
    const responseTime = Date.now() - startTime;
    
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      environment: NODE_ENV,
      uptime: process.uptime(),
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
      },
      database: {
        status: 'connected',
        responseTime: responseTime
      },
      sse: {
        activeClients: clients.size,
        totalConnections: clientCounter
      },
      version: process.env.npm_package_version || '1.0.0'
    });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      database: {
        status: 'disconnected',
        error: error.message
      },
      sse: {
        activeClients: clients.size
      }
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found',
    path: req.path,
    method: req.method
  });
});

// Global error handler
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    timestamp: new Date().toISOString(),
    ...(NODE_ENV === 'development' && { 
      error: error.message,
      stack: error.stack 
    })
  });
});

// Helper functions
function formatDate(dateString) {
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) {
      throw new Error('Invalid date');
    }
    const options = { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric',
      timeZone: 'UTC'
    };
    return date.toLocaleDateString('en-US', options);
  } catch (error) {
    console.error('Date formatting error:', error);
    return dateString;
  }
}

function formatTime(timeString) {
  try {
    const [hours, minutes] = timeString.split(':');
    const hour24 = parseInt(hours);
    const formattedHours = hour24.toString().padStart(2, '0');
    const formattedMinutes = minutes.padStart(2, '0');
    return `${formattedHours}:${formattedMinutes}`;
  } catch (error) {
    console.error('Time formatting error:', error);
    return timeString;
  }
}

// Graceful shutdown
async function gracefulShutdown(signal) {
  console.log(`\n🔄 Received ${signal}. Gracefully shutting down...`);
  
  // Stop accepting new connections
  server.close(() => {
    console.log('🛑 HTTP server closed');
  });
  
  // Close SSE connections
  console.log(`📡 Closing ${clients.size} SSE connections...`);
  clients.forEach((client, id) => {
    try {
      client.response.write(`data: ${JSON.stringify({ 
        type: 'shutdown', 
        message: 'Server shutting down' 
      })}\n\n`);
      client.response.end();
    } catch (error) {
      console.error(`Error closing client ${id}:`, error.message);
    }
  });
  clients.clear();
  
  // Disconnect from database
  try {
    await prisma.$disconnect();
    console.log('📦 Database connection closed');
  } catch (error) {
    console.error('Error closing database connection:', error.message);
  }
  
  console.log('✅ Graceful shutdown complete');
  process.exit(0);
}

// Process signal handlers
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle uncaught exceptions (prevent SSE crashes)
process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught exception:', error);
  console.error('Stack:', error.stack);
  
  // Don't exit on SSE-related header errors
  if (error.code === 'ERR_HTTP_HEADERS_SENT') {
    console.log('⚠️ Headers already sent error (likely SSE related) - continuing operation...');
    return;
  }
  
  // Don't exit on other common SSE errors
  if (error.message && (
    error.message.includes('Cannot set headers') ||
    error.message.includes('write after end') ||
    error.message.includes('This socket has been ended')
  )) {
    console.log('⚠️ SSE connection error - continuing operation...');
    return;
  }
  
  // For other critical errors, gracefully shutdown
  console.log('🚨 Critical error detected, shutting down...');
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled rejection at:', promise, 'reason:', reason);
  console.log('⚠️ Unhandled rejection - continuing operation...');
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Environment: ${NODE_ENV}`);
  console.log(`🗄️  Database: ${process.env.DATABASE_URL ? 'Connected' : 'Not configured'}`);
  console.log(`🌐 CORS Origins: ${allowedOrigins.join(', ')}`);
  console.log(`⚡ Ready for production deployment!`);
});

// Handle server startup errors
server.on('error', (error) => {
  console.error('Server startup error:', error);
  if (error.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use`);
    process.exit(1);
  }
});

// Prevent server timeout
server.timeout = 30000; // 30 seconds
server.keepAliveTimeout = 65000; // 65 seconds
server.headersTimeout = 66000; // 66 seconds

module.exports = app;