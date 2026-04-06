const express = require('express');
const puppeteer = require('puppeteer');
const cron = require('node-cron');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// Store user credentials and booking status
let userCredentials = null;
let botStatus = {
  isRunning: false,
  lastCheck: null,
  nextCheck: null,
  bookingAttempts: 0,
  successfulBookings: 0,
  errors: []
};

let browser = null;

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Tennis Bot API Running', uptime: process.uptime() });
});

// Get current status
app.get('/api/status', (req, res) => {
  res.json({
    ...botStatus,
    hasCredentials: !!userCredentials
  });
});

// Set user credentials
app.post('/api/credentials', (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  
  userCredentials = { username, password };
  logActivity('Credentials updated');
  
  res.json({ message: 'Credentials saved successfully' });
});

// Start/stop the bot
app.post('/api/bot/:action', (req, res) => {
  const action = req.params.action;
  
  if (action === 'start') {
    if (!userCredentials) {
      return res.status(400).json({ error: 'Please set credentials first' });
    }
    
    startBot();
    res.json({ message: 'Bot started' });
  } else if (action === 'stop') {
    stopBot();
    res.json({ message: 'Bot stopped' });
  } else {
    res.status(400).json({ error: 'Invalid action' });
  }
});

// Manual booking attempt
app.post('/api/book-now', async (req, res) => {
  if (!userCredentials) {
    return res.status(400).json({ error: 'Please set credentials first' });
  }
  
  try {
    const result = await attemptBooking();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clear logs
app.post('/api/clear-logs', (req, res) => {
  botStatus.errors = [];
  botStatus.bookingAttempts = 0;
  botStatus.successfulBookings = 0;
  logActivity('Logs cleared');
  res.json({ message: 'Logs cleared' });
});

function logActivity(message) {
  const timestamp = new Date().toLocaleString();
  const logMessage = `[${timestamp}] ${message}`;
  console.log(logMessage);
  
  // Keep only last 50 errors
  if (botStatus.errors.length > 50) {
    botStatus.errors = botStatus.errors.slice(-50);
  }
  
  botStatus.errors.unshift(logMessage);
  
  // Emit to connected clients
  io.emit('log', logMessage);
  io.emit('statusUpdate', botStatus);
}

function startBot() {
  if (botStatus.isRunning) return;
  
  botStatus.isRunning = true;
  logActivity('Bot started - monitoring for reservations');
  
  // Check every 30 seconds for available reservations
  const checkInterval = setInterval(async () => {
    if (!botStatus.isRunning) {
      clearInterval(checkInterval);
      return;
    }
    
    botStatus.lastCheck = new Date().toLocaleString();
    botStatus.nextCheck = new Date(Date.now() + 30000).toLocaleString();
    
    try {
      await checkAndBook();
    } catch (error) {
      logActivity(`Error during check: ${error.message}`);
    }
    
    io.emit('statusUpdate', botStatus);
  }, 30000);
  
  // Also schedule for common reservation opening times
  // SF Rec typically opens reservations at 8 AM, 7 days in advance
  cron.schedule('0 8 * * *', async () => {
    if (botStatus.isRunning) {
      logActivity('Daily reservation check at 8 AM');
      try {
        await checkAndBook();
      } catch (error) {
        logActivity(`Scheduled check error: ${error.message}`);
      }
    }
  });
}

function stopBot() {
  botStatus.isRunning = false;
  logActivity('Bot stopped');
  
  if (browser) {
    browser.close();
    browser = null;
  }
}

async function checkAndBook() {
  if (!userCredentials) {
    logActivity('No credentials available');
    return;
  }
  
  try {
    logActivity('Checking for available courts...');
    const result = await attemptBooking();
    
    if (result.success) {
      logActivity(`SUCCESS: ${result.message}`);
      botStatus.successfulBookings++;
    } else {
      logActivity(`No booking made: ${result.message}`);
    }
  } catch (error) {
    logActivity(`Booking check failed: ${error.message}`);
  }
}

async function attemptBooking() {
  botStatus.bookingAttempts++;
  
  if (!browser) {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  }
  
  const page = await browser.newPage();
  
  try {
    // Navigate to SF Rec Park tennis reservations
    await page.goto('https://sfrecpark.org/1446/Reservable-Tennis-Courts', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    logActivity('Loaded SF Rec Park page');
    
    // Look for reservation links or buttons
    await page.waitForTimeout(2000);
    
    // Try to find Alice Marble tennis courts reservation link
    const aliceMarbleLink = await page.$x("//a[contains(text(), 'Alice Marble') or contains(text(), 'alice marble')]//ancestor::a");
    
    if (aliceMarbleLink.length > 0) {
      logActivity('Found Alice Marble reservation link');
      await aliceMarbleLink[0].click();
      await page.waitForNavigation({ waitUntil: 'networkidle2' });
    } else {
      // Try to find any reservation system link
      const reservationLinks = await page.$$eval('a', links => 
        links.filter(link => 
          link.textContent.toLowerCase().includes('reservation') ||
          link.textContent.toLowerCase().includes('book') ||
          link.href.includes('recreation.gov') ||
          link.href.includes('activesg') ||
          link.href.includes('tennis')
        ).map(link => ({ text: link.textContent, href: link.href }))
      );
      
      if (reservationLinks.length > 0) {
        logActivity(`Found reservation links: ${reservationLinks.map(l => l.text).join(', ')}`);
        await page.goto(reservationLinks[0].href, { waitUntil: 'networkidle2' });
      } else {
        throw new Error('No reservation links found on the page');
      }
    }
    
    // Wait for the reservation page to load
    await page.waitForTimeout(3000);
    
    // Try to find login/account fields
    const loginSelectors = [
      'input[type="email"]',
      'input[name="username"]',
      'input[name="email"]',
      'input[id*="login"]',
      'input[id*="email"]',
      'input[id*="user"]'
    ];
    
    let loginField = null;
    for (const selector of loginSelectors) {
      try {
        loginField = await page.$(selector);
        if (loginField) break;
      } catch (e) {}
    }
    
    if (loginField) {
      logActivity('Found login form, attempting to log in');
      
      // Fill in credentials
      await loginField.type(userCredentials.username);
      
      const passwordField = await page.$('input[type="password"]');
      if (passwordField) {
        await passwordField.type(userCredentials.password);
        
        // Try to find and click login button
        const loginButton = await page.$('button[type="submit"], input[type="submit"], button:contains("Login"), button:contains("Sign in")');
        if (loginButton) {
          await loginButton.click();
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
        }
      }
    }
    
    // Look for available tennis court slots
    await page.waitForTimeout(2000);
    
    // Common selectors for available time slots
    const availableSlots = await page.$$eval(
      'button:not([disabled]), .available, .bookable, [data-available="true"]',
      elements => elements.filter(el => 
        !el.disabled &&
        (el.textContent.includes('AM') || el.textContent.includes('PM') || 
         el.classList.contains('available') || el.classList.contains('bookable'))
      ).length
    );
    
    if (availableSlots > 0) {
      logActivity(`Found ${availableSlots} potentially available slots`);
      
      // Try to book the first available slot
      const firstSlot = await page.$('button:not([disabled]):first-of-type, .available:first-of-type');
      if (firstSlot) {
        await firstSlot.click();
        await page.waitForTimeout(1000);
        
        // Look for confirm booking button
        const confirmButton = await page.$('button:contains("Book"), button:contains("Reserve"), button:contains("Confirm")');
        if (confirmButton) {
          await confirmButton.click();
          logActivity('Clicked booking confirmation button');
          
          await page.waitForTimeout(2000);
          
          return {
            success: true,
            message: 'Court booking attempted successfully'
          };
        }
      }
    }
    
    return {
      success: false,
      message: 'No available courts found at this time'
    };
    
  } catch (error) {
    throw new Error(`Booking attempt failed: ${error.message}`);
  } finally {
    await page.close();
  }
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Client connected');
  
  // Send current status to new client
  socket.emit('statusUpdate', botStatus);
  
  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Serve the main HTML page
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  stopBot();
  if (browser) {
    await browser.close();
  }
  server.close(() => {
    process.exit(0);
  });
});

server.listen(PORT, () => {
  console.log(`SF Tennis Bot server running on port ${PORT}`);
});