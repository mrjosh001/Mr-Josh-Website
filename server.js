const express = require('express');
const path = require('path');
const app = express();

// This line tells Express to serve CSS and other files from the current folder
app.use(express.static(path.join(__dirname)));

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT);
