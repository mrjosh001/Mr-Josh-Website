const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.send('MJ HUB Backend is live and running successfully!');
});

app.get('/api/status', (req, res) => {
    res.json({ status: 'success', message: 'Backend connected' });
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
