export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const apiKey = 'rsk_live_s5ATWd0yskBvEagViPwQd6HxwfdLrkkpGyZIZFXDnhPEj8W6';

  try {
    const apiRes = await fetch('https://fadded.net/api/v1/reseller/products', {
      method: 'GET',
      headers: {
        'X-Api-Key': apiKey,
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      }
    });

    if (!apiRes.ok) {
      const errorText = await apiRes.text();
      return res.status(apiRes.status).json({ 
        success: false, 
        message: `External API error: ${apiRes.status}`, 
        details: errorText 
      });
    }

    const data = await apiRes.json();
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ 
      success: false, 
      message: 'Internal Function Error', 
      error: error.message 
    });
  }
}
