import SteamUser from 'steam-user';
import SteamTotp from 'steam-totp';
import { LoginSession, EAuthTokenPlatformType } from 'steam-session';
import { EventEmitter } from 'events';
import { createRequire } from 'module';

const customRequire = createRequire(import.meta.url);

// Patch SteamUser.prototype._sendUnified globally for missing Unified protobuf definitions
try {
  const Schema = customRequire('steam-user/protobufs/generated/_load.js');
  const origSendUnified = SteamUser.prototype._sendUnified;

  SteamUser.prototype._sendUnified = function (methodName: string, methodData: any, callback?: any) {
    const [serviceName, interfaceMethod] = methodName.split('.');
    const [method] = (interfaceMethod || '').split('#');

    let reqName = 'C' + serviceName + '_' + method + '_Request';
    let respName = 'C' + serviceName + '_' + method + '_Response';

    if (methodName === 'Authentication.EnumerateTokens#1') {
      reqName = 'CAuthentication_RefreshToken_Enumerate_Request';
      respName = 'CAuthentication_RefreshToken_Enumerate_Response';
    } else if (methodName === 'Authentication.RevokeRefreshToken#1') {
      reqName = 'CAuthentication_RefreshToken_Revoke_Request';
      respName = 'CAuthentication_RefreshToken_Revoke_Response';
    }

    if (Schema[reqName] && Schema[respName]) {
      const requestProto = Schema[reqName];
      const responseProto = Schema[respName];
      const header = { msg: 7200, proto: { target_job_name: methodName } };
      return this._send(header, requestProto.encode(methodData || {}).finish(), (bodyBuf: any, hdr: any) => {
        if (!callback) return;
        try {
          const decoded = responseProto.decode(bodyBuf);
          callback(decoded, hdr);
        } catch (e) {
          callback(null, hdr);
        }
      });
    }

    if (typeof origSendUnified === 'function') {
      try {
        return origSendUnified.call(this, methodName, methodData, callback);
      } catch (err: any) {
        if (callback) callback(null, { proto: { eresult: 2 } });
        return;
      }
    }
    if (callback) callback(null, { proto: { eresult: 2 } });
  };
} catch (e) {
  console.error('Error patching SteamUser._sendUnified:', e);
}

export type LogLevel = 'info' | 'warn' | 'error' | 'success';
export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  message: string;
}

function formatSteamError(errMessage: string): string {
  if (!errMessage) return 'An unknown error occurred during login.';
  if (errMessage.includes('AccountLoginDeniedThrottle') || errMessage.includes('RateLimitExceeded') || errMessage.includes('LimitExceeded')) {
    return 'Steam has temporarily throttled password logins on this IP. Please wait a few minutes or use QR code login.';
  }
  if (errMessage.includes('FileNotFound')) {
    return 'Steam account not found or login session expired. Please check your username.';
  }
  if (errMessage.includes('InvalidPassword') || errMessage.includes('InvalidCredentials')) {
    return 'Invalid username or password.';
  }
  if (errMessage.includes('TwoFactorCodeMismatch')) {
    return 'Incorrect Steam Guard / 2FA code.';
  }
  if (errMessage.includes('AccountNotFound')) {
    return 'Steam account not found.';
  }
  if (errMessage.includes('AccountDisabled') || errMessage.includes('AccountLocked')) {
    return 'This Steam account is disabled or locked.';
  }
  if (errMessage.includes('Expired')) {
    return 'Login session expired. Please try logging in again.';
  }
  return errMessage;
}

export class SteamBot extends EventEmitter {
  public client: SteamUser | null = null;
  private loginSession: LoginSession | null = null;

  public status: 'offline' | 'connecting' | 'awaiting_guard_code' | 'awaiting_qr' | 'boosting' | 'error' = 'offline';
  public accountName = '';
  public activeGames: number[] = [];
  public customGameName = '';
  public personaState = 1; // 1 = Online, 7 = Invisible, 3 = Away, 2 = Busy, 4 = Snooze
  public startTime: number | null = null;
  public lastError: string | null = null;
  public logs: LogEntry[] = [];
  public needsCodeType: 'twoFactor' | 'emailGuard' | null = null;
  public qrChallengeUrl: string | null = null;
  public currentRefreshToken: string | null = null;
  public ownedGamesStats: Map<number, { name: string; playtimeForeverMinutes: number; playtime2WeeksMinutes: number }> = new Map();

  private pendingGuardCallback: ((code: string) => void) | null = null;

  constructor() {
    super();
    this.log('info', 'Steam Management Engine initialized.');
  }

  public log(level: LogLevel, message: string) {
    const entry: LogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toLocaleTimeString(),
      level,
      message,
    };
    this.logs.push(entry);
    if (this.logs.length > 500) this.logs.shift();
    this.emit('log', entry);
    this.emit('stateUpdate');
  }

  public get getState() {
    const elapsedSeconds = this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0;
    const sessionHours = Number((elapsedSeconds / 3600).toFixed(2));
    const gameStats: Record<number, { appId: number; name?: string; sessionSeconds: number; sessionHours: number; baseLifetimeHours: number; totalHours: number }> = {};
    
    let totalLifetimeHoursAllGames = 0;

    if (this.status === 'boosting') {
      for (const appId of this.activeGames) {
        const stats = this.ownedGamesStats.get(appId);
        const baseLifetimeHours = stats ? Number((stats.playtimeForeverMinutes / 60).toFixed(1)) : 0;
        const totalHours = Number((baseLifetimeHours + sessionHours).toFixed(2));
        totalLifetimeHoursAllGames += totalHours;

        gameStats[appId] = {
          appId,
          name: stats?.name,
          sessionSeconds: elapsedSeconds,
          sessionHours,
          baseLifetimeHours,
          totalHours,
        };
      }
    }

    return {
      status: this.status,
      accountName: this.accountName,
      personaState: this.personaState,
      activeGames: this.activeGames,
      customGameName: this.customGameName,
      startTime: this.startTime,
      elapsedSeconds,
      gameStats,
      totalLifetimeHoursAllGames: Number(totalLifetimeHoursAllGames.toFixed(1)),
      lastError: this.lastError,
      needsCodeType: this.needsCodeType,
      qrChallengeUrl: this.qrChallengeUrl,
      refreshToken: this.currentRefreshToken,
      logs: this.logs,
    };
  }

  public refreshOwnedGamesStats() {
    if (!this.client || this.status !== 'boosting' || !this.client.steamID) return;
    try {
      if (typeof this.client.getUserOwnedApps === 'function') {
        this.client.getUserOwnedApps(
          this.client.steamID,
          {
            includePlayedFreeGames: true,
            includeFreeSub: true,
            skipUnvettedApps: false,
          },
          (err: any, response: any) => {
            if (!err && response?.apps && Array.isArray(response.apps)) {
              for (const app of response.apps) {
                this.ownedGamesStats.set(app.appid, {
                  name: app.name || '',
                  playtimeForeverMinutes: app.playtime_forever || 0,
                  playtime2WeeksMinutes: app.playtime_2weeks || 0,
                });
              }
              this.emit('stateUpdate');
            }
          }
        );
      }
    } catch (e) {
      // Ignored
    }
  }

  private initClient() {
    if (this.client) {
      try {
        this.client.logOff();
        this.client.removeAllListeners();
      } catch (e) {}
    }
    this.client = new SteamUser({ promptSteamGuardCode: false, dataDirectory: null });

    this.client.on('loggedOn', () => {
      this.log('success', `Authenticated to Steam Network as ID64: ${this.client!.steamID?.getSteamID64()}`);
      this.status = 'boosting';
      this.lastError = null;
      this.needsCodeType = null;
      this.qrChallengeUrl = null;
      this.startTime = Date.now();
      
      this.applyGamesPlayed();
      this.refreshOwnedGamesStats();
      this.emit('stateUpdate');
    });

    this.client.on('ownershipCached', () => {
      this.refreshOwnedGamesStats();
    });

    this.client.on('refreshToken', (token: string) => {
      this.currentRefreshToken = token;
      this.log('info', 'Steam login refresh token received and cached.');
      this.emit('stateUpdate');
    });

    this.client.on('error', (err: any) => {
      this.log('error', `Steam Network Error: ${err.message}`);
      this.status = 'error';
      this.lastError = formatSteamError(err.message);
      this.startTime = null;
      this.needsCodeType = null;
      this.qrChallengeUrl = null;
      this.emit('stateUpdate');
    });

    this.client.on('steamGuard', (domain, callback) => {
      this.log('warn', `Steam Guard authorization required (Email domain: ${domain || 'N/A'})`);
      this.status = 'awaiting_guard_code';
      this.needsCodeType = 'emailGuard';
      this.pendingGuardCallback = callback;
      this.emit('stateUpdate');
    });

    this.client.on('disconnected', (eresult, msg) => {
      this.log('warn', `Disconnected from Steam Network: ${msg || eresult}`);
      if (this.status === 'boosting') {
        this.status = 'offline';
        this.startTime = null;
      }
      this.emit('stateUpdate');
    });

    this.client.on('loggedOff', (eresult, msg) => {
      this.log('warn', `Steam session logged off: EResult ${eresult}. Terminating background operations.`);
      this.stop();
    });
  }

  private applyPersonaState() {
    if (!this.client || this.status !== 'boosting') return;
    try {
      if (typeof (this.client as any)._send === 'function') {
        (this.client as any)._send(716, { // EMsg.ClientChangeStatus = 716
          persona_state: this.personaState,
          persona_set_by_user: true,
        });
      } else {
        this.client.setPersona(this.personaState);
      }
    } catch (e) {
      try {
        this.client.setPersona(this.personaState);
      } catch (err) {}
    }
  }

  private applyGamesPlayed() {
    if (!this.client || this.status !== 'boosting') return;
    const gamesToIdle: any[] = [];
    if (this.customGameName) {
      gamesToIdle.push({ game_id: 0, game_extra_info: this.customGameName });
    }
    if (this.activeGames && this.activeGames.length > 0) {
      gamesToIdle.push(...this.activeGames.slice(0, 32));
    }
    
    if (gamesToIdle.length > 0) {
      this.client.gamesPlayed(gamesToIdle);
      this.log('info', `Idling ${this.activeGames.length} games simultaneously [${this.activeGames.join(', ')}].`);
    } else {
      this.client.gamesPlayed([]);
      this.log('info', 'Connected to Steam. Idle list is empty.');
    }

    // Re-apply persona state AFTER gamesPlayed so idling games does not force persona state to Online
    this.applyPersonaState();
  }

  public submitGuardCode(code: string) {
    if (this.loginSession) {
      this.log('info', 'Submitting Steam Guard code...');
      this.loginSession.submitSteamGuardCode(code).catch((err) => {
        this.log('error', `Failed to submit Steam Guard code: ${err.message}`);
        this.status = 'error';
        this.lastError = formatSteamError(err.message);
        this.emit('stateUpdate');
      });
      this.status = 'connecting';
      this.needsCodeType = null;
      this.emit('stateUpdate');
      return true;
    }
    if (this.pendingGuardCallback) {
      this.log('info', 'Submitting Steam Guard code...');
      this.pendingGuardCallback(code);
      this.pendingGuardCallback = null;
      this.status = 'connecting';
      this.needsCodeType = null;
      this.emit('stateUpdate');
      return true;
    }
    return false;
  }

  public async startQRLogin(games: number[], customName: string, personaState: number) {
    this.activeGames = games;
    this.customGameName = customName;
    this.personaState = personaState;
    this.status = 'awaiting_qr';
    this.lastError = null;
    this.qrChallengeUrl = null;
    this.accountName = 'QR Login';

    if (this.loginSession) {
      try {
        this.loginSession.cancelLoginAttempt();
        this.loginSession.removeAllListeners();
      } catch (e) {}
      this.loginSession = null;
    }

    this.log('info', 'Generating new QR Code login session...');
    this.emit('stateUpdate');

    try {
      this.loginSession = new LoginSession(EAuthTokenPlatformType.SteamClient);

      this.loginSession.on('authenticated', () => {
        this.log('success', 'QR code scanned successfully! Connecting to Steam network...');
        this.accountName = this.loginSession!.accountName || 'QR User';
        this.currentRefreshToken = this.loginSession!.refreshToken;
        this.finishLogin({ refreshToken: this.loginSession!.refreshToken });
      });

      this.loginSession.on('timeout', () => {
        this.log('error', 'QR login session timed out.');
        this.stop();
      });

      this.loginSession.on('error', (err) => {
        this.log('error', `QR login error: ${err.message}`);
        this.stop();
      });

      const res = await this.loginSession.startWithQR();
      this.qrChallengeUrl = res.qrChallengeUrl;
      this.log('info', 'QR Code generated. Waiting for Steam mobile scan...');
      this.emit('stateUpdate');
    } catch (err: any) {
      this.log('error', `Failed to start QR session: ${err.message}`);
      this.status = 'error';
      this.lastError = formatSteamError(err.message);
      this.emit('stateUpdate');
    }
  }

  public async startCredentialsLogin(accountName: string, password: string, sharedSecret: string, games: number[], customName: string, personaState: number) {
    this.accountName = accountName;
    this.activeGames = games;
    this.customGameName = customName;
    this.personaState = personaState;
    this.status = 'connecting';
    this.lastError = null;
    this.needsCodeType = null;
    this.qrChallengeUrl = null;

    if (this.loginSession) {
      try {
        this.loginSession.cancelLoginAttempt();
        this.loginSession.removeAllListeners();
      } catch (e) {}
      this.loginSession = null;
    }

    this.log('info', `Connecting to Steam as ${accountName}...`);
    this.emit('stateUpdate');

    let steamGuardCode = '';
    if (sharedSecret) {
      try {
        steamGuardCode = SteamTotp.generateAuthCode(sharedSecret);
        this.log('info', 'Auto-generated 2FA code from shared secret.');
      } catch (e: any) {
        this.log('error', `Failed to generate 2FA: ${e.message}`);
      }
    }

    try {
      this.loginSession = new LoginSession(EAuthTokenPlatformType.MobileApp);

      this.loginSession.on('authenticated', () => {
        this.log('success', 'Credentials authenticated successfully! Connecting to Steam network...');
        this.accountName = this.loginSession!.accountName || accountName;
        this.currentRefreshToken = this.loginSession!.refreshToken;
        this.finishLogin({ refreshToken: this.loginSession!.refreshToken });
      });

      this.loginSession.on('timeout', () => {
        this.log('error', 'Login session timed out.');
        this.stop();
      });

      this.loginSession.on('error', (err) => {
        this.log('error', `Login error: ${err.message}`);
        this.status = 'error';
        this.lastError = formatSteamError(err.message);
        this.emit('stateUpdate');
      });

      const res = await this.loginSession.startWithCredentials({
        accountName,
        password,
        steamGuardCode: steamGuardCode || undefined,
      });

      if (res.actionRequired) {
        this.log('warn', 'Steam Guard authorization required.');
        this.status = 'awaiting_guard_code';
        this.needsCodeType = 'emailGuard';
        this.emit('stateUpdate');
      }
    } catch (err: any) {
      this.log('error', `Login failed: ${err.message}`);
      this.status = 'error';
      this.lastError = formatSteamError(err.message);
      this.emit('stateUpdate');
    }
  }

  public startTokenLogin(refreshToken: string, accountName: string, games: number[], customName: string, personaState: number) {
    this.accountName = accountName || this.accountName || 'Token User';
    this.activeGames = games;
    this.customGameName = customName;
    this.personaState = personaState;
    this.currentRefreshToken = refreshToken;
    this.status = 'connecting';
    this.lastError = null;
    this.needsCodeType = null;
    this.qrChallengeUrl = null;

    this.log('info', `Authenticating using saved login token...`);
    this.emit('stateUpdate');

    this.initClient();
    this.client!.logOn({ refreshToken });
  }

  private finishLogin(logOnOptions: any) {
    this.status = 'connecting';
    this.qrChallengeUrl = null;
    this.emit('stateUpdate');
    this.initClient();
    this.client!.logOn(logOnOptions);
  }

  public stop() {
    this.log('info', 'Logged out of Steam account.');
    if (this.currentRefreshToken) {
      this.log('info', 'Removing this login session from your Steam Authorized Devices...');
      const tokenToRevoke = this.currentRefreshToken;
      const steamIdStr = this.client && this.client.steamID ? this.client.steamID.getSteamID64() : null;
      
      fetch('https://api.steampowered.com/IAuthenticationService/RevokeToken/v1/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: tokenToRevoke,
          ...(steamIdStr ? { steamid: steamIdStr } : {})
        }).toString()
      }).then(res => {
        if (res.ok) {
          this.log('success', 'Successfully removed session from your Authorized Devices.');
        } else {
          this.log('warn', `Session removal from Authorized Devices returned status ${res.status}.`);
        }
      }).catch(err => {
        this.log('warn', `Failed to contact Steam device revocation service: ${err.message}`);
      });
      this.currentRefreshToken = null;
    }

    if (this.client) {
      try {
        this.client.logOff();
        this.client.removeAllListeners();
      } catch (e) {}
      this.client = null;
    }
    if (this.loginSession) {
      try {
        this.loginSession.cancelLoginAttempt();
        this.loginSession.removeAllListeners();
      } catch (e) {}
      this.loginSession = null;
    }
    this.status = 'offline';
    this.startTime = null;
    this.needsCodeType = null;
    this.qrChallengeUrl = null;
    this.emit('stateUpdate');
  }

  public updatePersona(personaState: number, customName?: string) {
    this.personaState = personaState;
    if (customName !== undefined) {
      this.customGameName = customName;
    }
    if (this.client && this.status === 'boosting') {
      this.applyGamesPlayed();
      this.log('info', `Updated persona status to ${this.personaState} and refreshed presence.`);
      this.emit('stateUpdate');
    }
  }

  public updateGames(games: number[], customName?: string) {
    this.activeGames = games.slice(0, 32);
    if (customName !== undefined) {
      this.customGameName = customName;
    }
    if (this.client && this.status === 'boosting') {
      this.applyGamesPlayed();
      this.emit('stateUpdate');
    }
  }

  public clearLogs() {
    this.logs = [];
    this.log('info', 'Logs cleared.');
    this.emit('stateUpdate');
  }
}
