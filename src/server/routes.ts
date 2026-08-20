import { Express, Request } from 'express';
import { botManager } from './BotManager';
import SteamTotp from 'steam-totp';
import { getGameName, POPULAR_GAMES_DATABASE } from '../data/games';

function getBotForRequest(req: Request) {
  const headerUser = req.headers['x-user-id'];
  const userId =
    (typeof headerUser === 'string' && headerUser.trim()) ||
    (typeof req.query.userId === 'string' && req.query.userId.trim()) ||
    (req.body && typeof req.body.userId === 'string' && req.body.userId.trim()) ||
    'default';
  return botManager.getBot(userId);
}

export function setupRoutes(app: Express) {
  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  // Get bot status for this user
  app.get('/api/status', (req, res) => {
    const bot = getBotForRequest(req);
    res.json(bot.getState);
  });

  // Start with credentials
  app.post('/api/bot/start', (req, res) => {
    const bot = getBotForRequest(req);
    let { accountName, password, sharedSecret, personaState = 1, gameIds = [], customGameName = '' } = req.body;
    
    if (accountName) {
      accountName = accountName.trim();
    }

    if (!accountName || !password) {
      return res.status(400).json({ error: 'Account name and password are required' });
    }

    bot.startCredentialsLogin(accountName, password, sharedSecret, gameIds, customGameName, personaState);
    res.json({ success: true, message: 'Login process started' });
  });

  // Start with saved Login Token (refreshToken)
  app.post('/api/bot/start-token', (req, res) => {
    const bot = getBotForRequest(req);
    const { refreshToken, accountName = '', personaState = 1, gameIds = [], customGameName = '' } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: 'Login token is required' });
    }
    bot.startTokenLogin(refreshToken, accountName, gameIds, customGameName, personaState);
    res.json({ success: true, message: 'Login with token started' });
  });

  // Start with QR
  app.post('/api/bot/start-qr', async (req, res) => {
    const bot = getBotForRequest(req);
    const { personaState = 1, gameIds = [], customGameName = '' } = req.body;
    await bot.startQRLogin(gameIds, customGameName, personaState);
    res.json({ success: true, message: 'QR session initiated' });
  });

  // Stop bot (Log out)
  app.post('/api/bot/stop', (req, res) => {
    const bot = getBotForRequest(req);
    bot.stop();
    res.json({ success: true, status: 'offline' });
  });

  // Update Persona Status & Custom Game Name live without relogging
  app.post('/api/bot/update-persona', (req, res) => {
    const bot = getBotForRequest(req);
    const { personaState = 1, customGameName } = req.body;
    bot.updatePersona(personaState, customGameName);
    res.json({ success: true, personaState, customGameName });
  });

  // Update active games while connected
  app.post('/api/bot/update-games', (req, res) => {
    const bot = getBotForRequest(req);
    const { gameIds = [], customGameName } = req.body;
    bot.updateGames(gameIds, customGameName);
    res.json({ success: true, message: `Updated active games to ${gameIds.length} titles` });
  });

  // Submit manual 2FA/Guard Code
  app.post('/api/bot/submit-code', (req, res) => {
    const bot = getBotForRequest(req);
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ error: 'Code is required' });
    }
    const submitted = bot.submitGuardCode(code);
    res.json({ success: submitted, message: submitted ? 'Code submitted' : 'No code pending' });
  });

  // Generate TOTP manually
  app.post('/api/totp/generate', (req, res) => {
    const { sharedSecret } = req.body;
    if (!sharedSecret) return res.status(400).json({ error: 'Shared secret required' });

    try {
      const code = SteamTotp.generateAuthCode(sharedSecret);
      const timeOffset = SteamTotp.time();
      const secondsRemaining = 30 - (timeOffset % 30);
      res.json({ code, secondsRemaining, timeOffset });
    } catch (e: any) {
      res.status(500).json({ error: e.message || 'Invalid secret format' });
    }
  });

  // Get owned games from Steam Library (with recently played merged for complete history)
  app.get('/api/steam/owned-games', async (req, res) => {
    const bot = getBotForRequest(req);
    if (!bot.client || bot.status !== 'boosting') {
      return res.status(400).json({ error: 'Steam account must be logged in to fetch library games.' });
    }
    try {
      if (!bot.client.steamID) {
        return res.status(400).json({ error: 'Bot steamID is not available.' });
      }

      // Fetch owned apps (includes paid and played free games with appinfo)
      const ownedAppsPromise = new Promise<any[]>((resolve) => {
        if (typeof bot.client.getUserOwnedApps === 'function') {
          bot.client.getUserOwnedApps(
            bot.client.steamID,
            {
              includeAppInfo: true,
              includePlayedFreeGames: true,
              includeFreeSub: true,
              skipUnvettedApps: false,
            },
            (err: any, response: any) => {
              if (err) resolve([]);
              else resolve(response?.apps || []);
            }
          );
        } else {
          resolve([]);
        }
      });

      // Fetch recently played games (to merge recent playtime and ensure accuracy)
      const recentlyPlayedPromise = new Promise<any[]>((resolve) => {
        if (typeof bot.client._sendUnified === 'function') {
          bot.client._sendUnified(
            'Player.GetRecentlyPlayedGames#1',
            {
              steamid: bot.client.steamID!.toString(),
              count: 100,
            },
            (body: any, hdr: any) => {
              resolve(body?.games || []);
            }
          );
        } else {
          resolve([]);
        }
      });

      const [ownedApps, recentlyPlayed] = await Promise.all([ownedAppsPromise, recentlyPlayedPromise]);

      // Merge results to build the ultimate, duplicate-free list of all games played
      const mergedMap = new Map<number, any>();

      for (const app of ownedApps) {
        mergedMap.set(app.appid, {
          appid: app.appid,
          name: app.name || getGameName(app.appid),
          playtime_forever: app.playtime_forever || 0,
          playtime_2weeks: app.playtime_2weeks || 0,
        });
      }

      for (const game of recentlyPlayed) {
        const appid = game.appid;
        const existing = mergedMap.get(appid);
        if (existing) {
          existing.playtime_forever = game.playtime_forever || existing.playtime_forever;
          existing.playtime_2weeks = game.playtime_2weeks || existing.playtime_2weeks;
          if (game.name) existing.name = game.name;
        } else {
          mergedMap.set(appid, {
            appid: appid,
            name: game.name || getGameName(appid),
            playtime_forever: game.playtime_forever || 0,
            playtime_2weeks: game.playtime_2weeks || 0,
          });
        }
      }

      // Merge popular defaults if library is sparse or empty
      for (const preset of POPULAR_GAMES_DATABASE) {
        if (!mergedMap.has(preset.appId)) {
          mergedMap.set(preset.appId, {
            appid: preset.appId,
            name: preset.name,
            playtime_forever: 0,
            playtime_2weeks: 0,
          });
        }
      }

      const apps = Array.from(mergedMap.values());
      return res.json({ apps });
    } catch (e: any) {
      res.status(500).json({ error: e.message || 'Internal server error' });
    }
  });

  // Get active authorized devices/sessions on Steam
  app.get('/api/steam/active-devices', async (req, res) => {
    const bot = getBotForRequest(req);
    if (!bot.client || bot.status !== 'boosting') {
      return res.status(400).json({ error: 'Steam account must be logged in to fetch active devices.' });
    }
    try {
      if (typeof bot.client._sendUnified !== 'function') {
        return res.json({ devices: [] });
      }

      bot.client._sendUnified('Authentication.EnumerateTokens#1', {}, (body: any, hdr: any) => {
        if (!body || !Array.isArray(body.refresh_tokens)) {
          return res.json({ devices: [] });
        }

        const requestingTokenStr = body.requesting_token ? body.requesting_token.toString() : '';

        const devices = body.refresh_tokens.map((token: any) => {
          const tokenIdStr = token.token_id ? token.token_id.toString() : '';
          return {
            tokenId: tokenIdStr,
            description: token.token_description || 'Steam Client / Mobile Device',
            timeUpdated: token.time_updated ? token.time_updated : null,
            platformType: token.platform_type,
            loggedIn: token.logged_in,
            osPlatform: token.os_platform,
            isCurrentDevice: tokenIdStr === requestingTokenStr,
            lastSeen: token.last_seen ? {
              time: token.last_seen.time ? token.last_seen.time : null,
              country: token.last_seen.country || '',
              state: token.last_seen.state || '',
              city: token.last_seen.city || '',
            } : null,
          };
        });

        return res.json({ devices });
      });
    } catch (e: any) {
      return res.json({ devices: [] });
    }
  });

  // Revoke/Deauthorize an active device/session
  app.post('/api/steam/revoke-device', async (req, res) => {
    const bot = getBotForRequest(req);
    if (!bot.client || bot.status !== 'boosting') {
      return res.status(400).json({ error: 'Steam account must be logged in to revoke devices.' });
    }
    try {
      const { tokenId } = req.body;
      if (!tokenId) {
        return res.status(400).json({ error: 'tokenId is required.' });
      }

      if (typeof bot.client._sendUnified !== 'function') {
        return res.status(500).json({ error: 'Unified message API is not supported on this client.' });
      }

      bot.client._sendUnified(
        'Authentication.RevokeRefreshToken#1',
        {
          token_id: tokenId,
          revoke_action: 1, // k_EAuthTokenRevokePermanent
        },
        (body: any, hdr: any) => {
          return res.json({ success: true });
        }
      );
    } catch (e: any) {
      return res.status(500).json({ error: e.message || 'Internal server error' });
    }
  });

  // Search Steam Store
  app.get('/api/steam/search', async (req, res) => {
    const term = req.query.term as string;
    if (!term) return res.status(400).json({ error: 'Search term required' });
    try {
      const resp = await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=US`);
      const data = await resp.json();
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Clear logs
  app.post('/api/bot/clear-logs', (req, res) => {
    const bot = getBotForRequest(req);
    bot.clearLogs();
    res.json({ success: true });
  });
}
