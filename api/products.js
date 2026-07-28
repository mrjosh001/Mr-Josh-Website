export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const apiKey = 'rsk_live_s5ATWd0yskBvEagViPwQd6HxwfdLrkkpGyZIZFXDnhPEj8W6';

  try {
    const response = await fetch('https://fadded.net/api/v1/reseller/products', {
      method: 'GET',
      headers: {
        'X-Api-Key': apiKey,
        'Accept': 'application/json'
      }
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = { raw: text };
    }

    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}
