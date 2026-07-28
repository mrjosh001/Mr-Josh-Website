module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const apiKey = 'rsk_live_s5ATWd0yskBvEagViPwQd6HxwfdLrkkpGyZIZFXDnhPEj8W6';
  
  try {
    const apiRes = await fetch('https://fadded.net/api/v1/reseller/products', {
      method: 'GET',
      headers: {
        'X-Api-Key': apiKey,
        'Accept': 'application/json'
      }
    });

    const data = await apiRes.json();
    return res.status(200).send(JSON.stringify(data));
  } catch (error) {
    return res.status(500).send(JSON.stringify({ success: false, message: error.message }));
  }
};
