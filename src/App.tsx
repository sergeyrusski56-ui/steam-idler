import React, { useState, useEffect } from 'react';
import { Header } from './components/Header';
import { DashboardView } from './components/DashboardView';
import { AccountView } from './components/AccountView';
import { GamesView } from './components/GamesView';
import { DevicesView } from './components/DevicesView';
import { SteamGuardModal } from './components/SteamGuardModal';
import { BotConfig, BotState } from './types';
import { apiFetch, parseJsonResponse } from './lib/api';
import { ConfirmModal } from './components/ConfirmModal';
import { motion, AnimatePresence } from 'motion/react';
import { Loader2 } from 'lucide-react';

export default function App() {
  // App Navigation & Session State
  const [activeTab, setActiveTab] = useState<'account' | 'games' | 'devices' | 'dashboard'>('account');
  const [isLoading, setIsLoading] = useState(false);
  const [loadingText, setLoadingText] = useState<string | null>(null);
  const [isDisconnectModalOpen, setIsDisconnectModalOpen] = useState(false);

  // Bot Configuration (Zero browser caching)
  const [config, setConfig] = useState<BotConfig>({
    accountName: '',
    personaState: 1,
    gameIds: [],
    customGameName: '',
  });

  // Bot Live Telemetry State
  const [botState, setBotState] = useState<BotState>({
    status: 'offline',
    accountName: '',
    personaState: 1,
    activeGames: [],
    customGameName: '',
    startTime: null,
    elapsedSeconds: 0,
    lastError: null,
    needsCodeType: null,
    qrChallengeUrl: null,
    logs: [],
  });

  // Update in-memory state only
  const handleConfigChange = (newConfig: BotConfig) => {
    setConfig(newConfig);
  };

  // Ensure protected tabs switch to 'account' if logged out of Steam
  useEffect(() => {
    if (botState.status !== 'boosting' && activeTab !== 'account') {
      setActiveTab('account');
    }
  }, [botState.status, activeTab]);

  // Poll Bot Status from Backend every 1.5 seconds
  const fetchStatus = async () => {
    try {
      const res = await apiFetch('/api/status');
      const contentType = res.headers.get('content-type');
      if (res.ok && contentType && contentType.includes('application/json')) {
        const data = await res.json();
        setBotState((prev) => ({
          ...prev,
          status: data.status,
          accountName: data.accountName || prev.accountName,
          personaState: data.personaState ?? prev.personaState,
          activeGames: data.activeGames || prev.activeGames,
          customGameName: data.customGameName ?? prev.customGameName,
          startTime: data.startTime,
          elapsedSeconds: data.elapsedSeconds,
          lastError: data.lastError,
          needsCodeType: data.needsCodeType,
          qrChallengeUrl: data.qrChallengeUrl,
          gameStats: data.gameStats || prev.gameStats,
          totalLifetimeHoursAllGames: data.totalLifetimeHoursAllGames,
          logs: data.logs || [],
        }));

        if (data.status === 'boosting' && data.activeGames && data.activeGames.length > 0) {
          setConfig((prev) => {
            // Avoid overwriting selected gameIds if the user is currently editing on the 'games' tab
            if (activeTab === 'games') {
              return {
                ...prev,
                accountName: data.accountName || prev.accountName,
              };
            }
            return {
              ...prev,
              accountName: data.accountName || prev.accountName,
              gameIds: data.activeGames,
            };
          });
        }
      }
    } catch (err) {
      console.error('Failed to poll status', err);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 1500);
    return () => clearInterval(interval);
  }, []);

  // Launch Bot Session via Credentials / Auto 2FA
  const handleStartBot = async (tempPassword?: string, tempSharedSecret?: string) => {
    const trimmedAccountName = config.accountName ? config.accountName.trim() : '';
    if (!trimmedAccountName || !tempPassword) {
      setActiveTab('account');
      alert('Please enter your Steam username and password.');
      return;
    }

    setIsLoading(true);
    setLoadingText('Initiating Steam connection...');
    try {
      const res = await apiFetch('/api/bot/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountName: trimmedAccountName,
          password: tempPassword,
          sharedSecret: tempSharedSecret,
          personaState: config.personaState,
          gameIds: config.gameIds,
          customGameName: config.customGameName,
        }),
      });
      await parseJsonResponse(res);
      fetchStatus();
    } catch (err: any) {
      alert(`Error starting Steam session: ${err.message}`);
    } finally {
      setIsLoading(false);
      setLoadingText(null);
    }
  };

  // Launch Bot Session via QR Code
  const handleStartQR = async () => {
    setIsLoading(true);
    setLoadingText('Generating secure QR Login token...');
    try {
      const res = await apiFetch('/api/bot/start-qr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personaState: config.personaState,
          gameIds: config.gameIds,
          customGameName: config.customGameName,
        }),
      });
      await parseJsonResponse(res);
      fetchStatus();
    } catch (err: any) {
      alert(`Error starting QR session: ${err.message}`);
    } finally {
      setIsLoading(false);
      setLoadingText(null);
    }
  };

  // Stop Bot Session (Logout Steam)
  const handleStopBot = async () => {
    setIsLoading(true);
    setLoadingText('removing this session on your Authorized Devices');
    try {
      const res = await apiFetch('/api/bot/stop', {
        method: 'POST',
      });
      if (res.ok) {
        fetchStatus();
        setActiveTab('account');
      }
    } catch (err) {
      console.error('Failed to logout', err);
    } finally {
      setIsLoading(false);
      setLoadingText(null);
    }
  };

  // Update Persona & Custom Name live without relogging
  const handleUpdatePersona = async (personaState: number, customName: string) => {
    handleConfigChange({ ...config, personaState, customGameName: customName });
    if (botState.status === 'boosting') {
      try {
        await apiFetch('/api/bot/update-persona', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            personaState,
            customGameName: customName,
          }),
        });
        fetchStatus();
      } catch (err) {
        console.error('Failed to update persona live', err);
      }
    }
  };

  // Submit 2FA / Steam Guard Code
  const handleSubmitCode = async (code: string) => {
    setIsLoading(true);
    setLoadingText('Verifying Steam Guard code...');
    try {
      const res = await apiFetch('/api/bot/submit-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      await parseJsonResponse(res);
      fetchStatus();
    } catch (err: any) {
      alert(`Error submitting code: ${err.message}`);
    } finally {
      setIsLoading(false);
      setLoadingText(null);
    }
  };

  // Clear Logs
  const handleClearLogs = async () => {
    try {
      await apiFetch('/api/bot/clear-logs', { method: 'POST' });
      fetchStatus();
    } catch (err) {
      console.error('Failed to clear logs', err);
    }
  };

  const isConnecting = botState.status === 'connecting';
  const showLoadingOverlay = isLoading || isConnecting;
  const currentLoadingMessage = loadingText || (isConnecting ? 'Authenticating with Steam... Please wait' : 'Loading, please wait...');

  return (
    <div className="min-h-screen bg-black text-white flex flex-col">
      {/* Header Bar */}
      <Header
        status={botState.status}
        accountName={botState.accountName || config.accountName}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onStart={() => handleStartBot()}
        onStop={handleStopBot}
        onRequestDisconnect={() => setIsDisconnectModalOpen(true)}
        isLoading={isLoading}
      />

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 overflow-hidden">
        <AnimatePresence mode="wait">
          {activeTab === 'account' && (
            <motion.div
              key="account"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <AccountView
                config={config}
                onChangeConfig={handleConfigChange}
                onSaveAndStart={handleStartBot}
                onStartQR={handleStartQR}
                onStopBot={handleStopBot}
                onRequestDisconnect={() => setIsDisconnectModalOpen(true)}
                onUpdatePersona={handleUpdatePersona}
                isLoading={isLoading}
                botStatus={botState.status}
                qrChallengeUrl={botState.qrChallengeUrl}
                lastError={botState.lastError}
              />
            </motion.div>
          )}

          {activeTab === 'games' && botState.status === 'boosting' && (
            <motion.div
              key="games"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <GamesView
                config={config}
                onChangeConfig={handleConfigChange}
                botState={botState}
              />
            </motion.div>
          )}

          {activeTab === 'devices' && botState.status === 'boosting' && (
            <motion.div
              key="devices"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <DevicesView />
            </motion.div>
          )}

          {activeTab === 'dashboard' && botState.status === 'boosting' && (
            <motion.div
              key="dashboard"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <DashboardView
                botState={botState}
                onStart={() => handleStartBot()}
                onStartQR={handleStartQR}
                onStop={handleStopBot}
                onClearLogs={handleClearLogs}
                onSwitchToGames={() => setActiveTab('games')}
                onSwitchToAccount={() => setActiveTab('account')}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Steam Guard 2FA Modal */}
      <SteamGuardModal
        isOpen={botState.status === 'awaiting_2fa' || botState.status === 'awaiting_guard_code'}
        needsCodeType={botState.needsCodeType}
        onSubmitCode={handleSubmitCode}
        onCancel={handleStopBot}
        isLoading={isLoading}
      />

      {/* Disconnect Steam Confirmation Modal */}
      <ConfirmModal
        isOpen={isDisconnectModalOpen}
        title="Disconnect Steam Session?"
        message="Are you sure you want to disconnect? This will log you out of your Steam account on the server, and all active 24/7 background game idling sessions will be deactivated immediately."
        warningText="Accumulated hours up to this moment are recorded on Steam. You can log in again anytime to resume."
        confirmText="Yes, Disconnect & Stop Idling"
        cancelText="Keep Idling"
        isDanger={true}
        isLoading={isLoading}
        onConfirm={handleStopBot}
        onCancel={() => setIsDisconnectModalOpen(false)}
      />

      {/* Global Loading Overlay */}
      <AnimatePresence>
        {showLoadingOverlay && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex flex-col items-center justify-center gap-4 text-center p-6"
          >
            <Loader2 className="w-10 h-10 text-white animate-spin" />
            <motion.p
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 }}
              className="text-sm font-medium text-zinc-300 font-mono tracking-wide uppercase animate-pulse"
            >
              {currentLoadingMessage}
            </motion.p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Footer */}
      <footer className="border-t border-zinc-900 bg-black py-4 text-xs text-zinc-600">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center flex items-center justify-between">
          <span>Steam Hour Booster &copy; Server Idler</span>
          <span className="text-zinc-500 font-mono text-[11px]">
            Server Active
          </span>
        </div>
      </footer>
    </div>
  );
}
