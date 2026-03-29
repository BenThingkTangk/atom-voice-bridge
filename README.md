# ATOM Voice Bridge

Real-time voice AI bridge connecting Twilio phone calls to Hume EVI (Empathic Voice Interface). 
ATOM sounds like a real person on the phone — with emotional intelligence, interruption handling, and natural conversation flow.

## Architecture

```
Phone Call → Twilio → Media Streams (WebSocket) → This Server → Hume EVI (WebSocket)
                                                       ↕
                                          Bidirectional real-time audio
```

## Setup

```bash
cp .env.example .env
# Edit .env with your credentials
npm install
npm start
```

## Making a call

```bash
curl -X POST http://your-server:6060/call \
  -H "Content-Type: application/json" \
  -d '{"to": "+16039302131", "contactName": "Ben", "companyName": "Nirmata", "productSlug": "atom-enterprise"}'
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `TWILIO_ACCOUNT_SID` | Twilio Account SID (AC...) |
| `TWILIO_API_KEY_SID` | Twilio API Key SID (SK...) |
| `TWILIO_API_KEY_SECRET` | Twilio API Key Secret |
| `TWILIO_PHONE_NUMBER` | Your Twilio phone number |
| `HUME_API_KEY` | Hume API key |
| `HUME_CONFIG_ID` | Hume EVI Config ID (ATOM Sales Agent) |
| `PORT` | Server port (default 6060) |
| `DOMAIN` | Public domain for WebSocket URL |
