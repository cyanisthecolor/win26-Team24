const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const app = express();

// allow cross‑origin requests (web client on localhost)
const cors = require('cors');
app.use(cors());
app.use(express.json());

// Store latest notifications for broadcasting
let latestNotifications = [];

app.get('/classify', (req, res) => {
  const token = req.query.token;
  if (!token) {
    return res.status(400).send({ error: 'token required' });
  }
  console.log('classify: starting with token', token.substring(0, 20) + '...');
  const script = path.join(__dirname, 'outlook_ingest.py');
  const py = spawn('python3', [script, '--token', token, '--quiet']);
  let output = '';
  let errOutput = '';
  
  py.stdout.on('data', (d) => {
    const chunk = d.toString();
    console.log('py stdout:', chunk.substring(0, 200));
    output += chunk;
  });
  py.stderr.on('data', (d) => {
    const msg = d.toString();
    errOutput += msg;
    console.error('py stderr:', msg);
  });
  py.on('error', (err) => {
    console.error('classify: spawn error:', err);
    res.status(500).send({ error: 'failed to spawn python', details: err.message });
  });
  py.on('close', (code) => {
    console.log('classify: python process exited with code', code);
    console.log('classify: output length:', output.length, 'error length:', errOutput.length);
    if (code !== 0) {
      console.error('classification failed, stderr:', errOutput);
      return res.status(500).send({ error: 'classification failed', stderr: errOutput, code: code });
    }
    try {
      const json = JSON.parse(output);
      console.log('classify: successfully parsed response with', json.notifications?.length || 0, 'notifications');
      res.json(json);
    } catch (e) {
      console.error('parse error', e, 'output:', output.substring(0, 500));
      res.status(500).send({ error: 'parse error', details: e.message, output: output.substring(0, 500) });
    }
  });
});

// Endpoint to receive updated notifications from Python backend
app.post('/update-notifications', (req, res) => {
  const { notifications } = req.body;
  if (!notifications || !Array.isArray(notifications)) {
    return res.status(400).send({ error: 'notifications array required' });
  }
  console.log('update-notifications: received', notifications.length, 'notifications');
  latestNotifications = notifications;
  res.json({ success: true, count: notifications.length });
});

// Endpoint to get latest notifications (for polling from app)
app.get('/notifications', (req, res) => {
  res.json({ notifications: latestNotifications });
});

// Endpoint to clear notifications
app.post('/clear-notifications', (req, res) => {
  console.log('clear-notifications: clearing all notifications');
  latestNotifications = [];
  
  // Also clear notifications in data.json
  try {
    const fs = require('fs');
    const dataPath = path.join(__dirname, 'data.json');
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    data.notifications = [];
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf-8');
    console.log('clear-notifications: cleared notifications in data.json');
  } catch (e) {
    console.error('clear-notifications: error updating data.json:', e);
  }
  
  res.json({ success: true, cleared: true });
});

// Endpoint to run summarize_inbox.py and update notifications
app.post('/summarize-inbox', (req, res) => {
  console.log('summarize-inbox: starting email summarization');
  const script = path.join(__dirname, 'summarize_inbox.py');
  const py = spawn('python3', [script]);
  let output = '';
  let errOutput = '';
  
  py.stdout.on('data', (d) => {
    output += d.toString();
  });
  py.stderr.on('data', (d) => {
    const msg = d.toString();
    errOutput += msg;
    console.error('summarize-inbox stderr:', msg);
  });
  py.on('close', (code) => {
    console.log('summarize-inbox: python process exited with code', code);
    if (code !== 0) {
      console.error('summarize-inbox failed, stderr:', errOutput);
      return res.status(500).send({ error: 'summarize-inbox failed', stderr: errOutput });
    }
    
    // Read updated notifications from data.json
    try {
      const fs = require('fs');
      const dataPath = path.join(__dirname, 'data.json');
      const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
      latestNotifications = data.notifications || [];
      console.log('summarize-inbox: loaded', latestNotifications.length, 'notifications from data.json');
      res.json({ success: true, notifications: latestNotifications, count: latestNotifications.length });
    } catch (e) {
      console.error('summarize-inbox: error reading data.json:', e);
      res.status(500).send({ error: 'failed to read updated notifications', details: e.message });
    }
  });
});

// Endpoint to mark a single notification as read and update data.json
app.post('/mark-read', (req, res) => {
  const { id } = req.body;
  if (!id) {
    return res.status(400).send({ error: 'id required' });
  }
  console.log('mark-read: marking notification', id);
  
  // Update in memory
  const notification = latestNotifications.find(n => n.id === id);
  if (notification) {
    notification.read = true;
  }
  
  // Also update data.json file
  try {
    const fs = require('fs');
    const dataPath = path.join(__dirname, 'data.json');
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    const notif = data.notifications.find(n => n.id === id);
    if (notif) {
      notif.read = true;
      fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf-8');
      console.log('mark-read: updated data.json for id', id);
    }
  } catch (e) {
    console.error('mark-read: error updating data.json:', e);
  }
  
  res.json({ success: true, id });
});

app.listen(3000, () => {
  console.log('classification server running on http://localhost:3000');
});