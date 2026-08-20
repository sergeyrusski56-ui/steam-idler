import React, { useState, useEffect } from 'react';
import {
  Gamepad2,
  Search,
  Plus,
  Check,
  Trash2,
  Loader2,
  Download,
  Layers,
  CheckCheck,
} from 'lucide-react';
import { BotConfig, BotState } from '../types';
import { getGameHeaderUrl, getGameName, POPULAR_GAMES_DATABASE } from '../data/games';
import { apiFetch } from '../lib/api';

interface GamesViewProps {
  config: BotConfig;
  onChangeConfig: (newConfig: BotConfig) => void;
  botState: BotState;
}

interface OwnedApp {
  appid: number;
  name?: string;
  playtime_forever?: number;
}

export const GamesView: React.FC<GamesViewProps> = ({
  config,
  onChangeConfig,
  botState,
}) => {
  const [activeSubTab, setActiveSubTab] = useState<'library' | 'search' | 'manual'>('library');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const [ownedGames, setOwnedGames] = useState<OwnedApp[]>(() =>
    POPULAR_GAMES_DATABASE.map((p) => ({
      appid: p.appId,
      name: p.name,
      playtime_forever: 0,
      playtime_2weeks: 0,
    }))
  );
  const [libraryFilter, setLibraryFilter] = useState('');
  const [isFetchingOwned, setIsFetchingOwned] = useState(false);
  const [hasFetchedOwned, setHasFetchedOwned] = useState(false);

  const [customAppIdInput, setCustomAppIdInput] = useState('');
  const [rawAppIdList, setRawAppIdList] = useState(config.gameIds.join(', '));
  const [isApplying, setIsApplying] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Auto-fetch owned library when opening view if connected and not fetched yet
  useEffect(() => {
    if (botState.status === 'boosting' && !hasFetchedOwned && !isFetchingOwned) {
      handleFetchOwned();
    }
  }, [botState.status, hasFetchedOwned, isFetchingOwned]);

  useEffect(() => {
    setRawAppIdList(config.gameIds.join(', '));
  }, [config.gameIds]);

  const handleUpdate = (fields: Partial<BotConfig>) => {
    onChangeConfig({ ...config, ...fields });
  };

  const handleToggleGame = (appId: number) => {
    let newIds = [...config.gameIds];
    if (newIds.includes(appId)) {
      newIds = newIds.filter((id) => id !== appId);
    } else {
      if (newIds.length >= 32) {
        setFeedbackMsg({ text: 'Maximum limit is 32 games simultaneously.', type: 'error' });
        setTimeout(() => setFeedbackMsg(null), 3000);
        return;
      }
      newIds.push(appId);
    }
    handleUpdate({ gameIds: newIds });
  };

  const handleApplyGames = async () => {
    setIsApplying(true);
    setError(null);
    try {
      if (botState.status === 'boosting') {
        const res = await apiFetch('/api/bot/update-games', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            gameIds: config.gameIds,
            customGameName: config.customGameName,
          }),
        });
        if (!res.ok) {
          throw new Error('Failed to update live games on Steam');
        }
        setFeedbackMsg({
          text: `Applied! Steam is now idling ${config.gameIds.length} games.`,
          type: 'success',
        });
      } else {
        setFeedbackMsg({
          text: `Saved ${config.gameIds.length} games to your configuration.`,
          type: 'success',
        });
      }
      setTimeout(() => setFeedbackMsg(null), 3000);
    } catch (err: any) {
      setFeedbackMsg({ text: err.message || 'Error applying game selection', type: 'error' });
    } finally {
      setIsApplying(false);
    }
  };

  const handleClearSelected = () => {
    handleUpdate({ gameIds: [] });
  };

  const handleAddCustomAppId = (e: React.FormEvent) => {
    e.preventDefault();
    const id = parseInt(customAppIdInput.trim(), 10);
    if (isNaN(id) || id <= 0) return;
    if (config.gameIds.includes(id)) {
      setCustomAppIdInput('');
      return;
    }
    if (config.gameIds.length >= 32) {
      setFeedbackMsg({ text: 'Maximum limit is 32 games.', type: 'error' });
      setTimeout(() => setFeedbackMsg(null), 3000);
      return;
    }
    handleUpdate({ gameIds: [...config.gameIds, id] });
    setCustomAppIdInput('');
  };

  const handleApplyRawCsv = () => {
    const parsed = rawAppIdList
      .split(/[\s,]+/)
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n) && n > 0);

    const unique: number[] = Array.from(new Set<number>(parsed)).slice(0, 32);
    handleUpdate({ gameIds: unique });
    setFeedbackMsg({ text: `Set selection to ${unique.length} games.`, type: 'success' });
    setTimeout(() => setFeedbackMsg(null), 2500);
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/steam/search?term=${encodeURIComponent(searchQuery)}`);
      if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
        const data = await res.json();
        setSearchResults(data.items || []);
      } else {
        setSearchResults([]);
      }
    } catch (err: any) {
      setError('Search failed. Check network connection.');
    } finally {
      setIsSearching(false);
    }
  };

  const handleFetchOwned = async () => {
    setIsFetchingOwned(true);
    setError(null);
    try {
      const res = await apiFetch('/api/steam/owned-games');
      const isJson = res.headers.get('content-type')?.includes('application/json');
      if (!isJson) {
        throw new Error('Server returned invalid response');
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch library.');

      const apps = data.apps || [];
      setOwnedGames(apps);
      setHasFetchedOwned(true);
      if (apps.length === 0) {
        setError('No owned games found on this account.');
      } else {
        setFeedbackMsg({ text: `Fetched ${apps.length} library games.`, type: 'success' });
        setTimeout(() => setFeedbackMsg(null), 2500);
      }
    } catch (err: any) {
      setError(err.message || 'Log in to Steam first to fetch library games.');
    } finally {
      setIsFetchingOwned(false);
    }
  };

  const filteredOwnedGames = ownedGames.filter((g) => {
    if (!libraryFilter.trim()) return true;
    const query = libraryFilter.toLowerCase();
    const matchesId = g.appid.toString().includes(query);
    const matchesName = g.name ? g.name.toLowerCase().includes(query) : false;
    return matchesId || matchesName;
  });

  const getDisplayName = (id: number) => {
    const fromOwned = ownedGames.find((g) => g.appid === id);
    if (fromOwned && fromOwned.name) return fromOwned.name;
    return getGameName(id);
  };

  return (
    <div className="space-y-6 w-full">
      {/* Header bar with counter */}
      <div className="border-b border-zinc-800 pb-4">
        <div className="flex items-center gap-2.5">
          <Gamepad2 className="w-5 h-5 text-white" />
          <h2 className="text-base font-bold text-white">Games Selection</h2>
          <span className="text-xs text-zinc-400 font-mono bg-zinc-900 border border-zinc-700 px-2 py-0.5 rounded">
            {config.gameIds.length}/32
          </span>
        </div>
      </div>

      {feedbackMsg && (
        <div
          className={`p-3 rounded text-xs font-medium flex items-center gap-2 ${
            feedbackMsg.type === 'success'
              ? 'bg-zinc-900 border border-zinc-700 text-white'
              : 'bg-red-950/40 border border-red-900/60 text-red-300'
          }`}
        >
          <CheckCheck className="w-4 h-4 shrink-0 text-white" />
          <span>{feedbackMsg.text}</span>
        </div>
      )}

      {/* Main Wide Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 w-full">
        {/* Left Column: Search & Library (8 cols on large screens) */}
        <div className="lg:col-span-8 space-y-4">
          <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-5">
            {/* Sub-Tabs */}
            <div className="flex items-center gap-2 border-b border-zinc-800 pb-3 mb-4 overflow-x-auto">
              <button
                type="button"
                onClick={() => setActiveSubTab('library')}
                className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-all duration-200 cursor-pointer shrink-0 hover:scale-[1.02] active:scale-[0.98] ${
                  activeSubTab === 'library'
                    ? 'bg-zinc-800 text-white border border-zinc-700'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Download className="w-3.5 h-3.5" />
                <span>All games played</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveSubTab('search')}
                className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-all duration-200 cursor-pointer shrink-0 hover:scale-[1.02] active:scale-[0.98] ${
                  activeSubTab === 'search'
                    ? 'bg-zinc-800 text-white border border-zinc-700'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Search className="w-3.5 h-3.5" />
                <span>Search Steam Store</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveSubTab('manual')}
                className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-all duration-200 cursor-pointer shrink-0 hover:scale-[1.02] active:scale-[0.98] ${
                  activeSubTab === 'manual'
                    ? 'bg-zinc-800 text-white border border-zinc-700'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
                <span>Manual AppIDs</span>
              </button>
            </div>

            {/* 1. All games played SubTab */}
            {activeSubTab === 'library' && (
              <div className="space-y-4">
                {botState.status !== 'boosting' && (
                  <div className="p-3 bg-zinc-900/60 border border-zinc-800 rounded text-xs text-zinc-300">
                    Steam account is offline. Displaying popular preset games. Log in to sync your full personal Steam library.
                  </div>
                )}

                <div className="flex gap-2">
                  <input
                    type="text"
                    value={libraryFilter}
                    onChange={(e) => setLibraryFilter(e.target.value)}
                    placeholder="Filter games by name or AppID..."
                    className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-xs text-white placeholder-zinc-500 focus:outline-hidden"
                  />
                  {botState.status === 'boosting' && (
                    <button
                      type="button"
                      onClick={handleFetchOwned}
                      disabled={isFetchingOwned}
                      className="px-3.5 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-white rounded text-xs font-medium flex items-center gap-1.5 cursor-pointer disabled:opacity-50 transition-all duration-200 hover:scale-[1.02] active:scale-[0.98]"
                    >
                      {isFetchingOwned ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Download className="w-3.5 h-3.5" />
                      )}
                      <span>Refresh Games List</span>
                    </button>
                  )}
                </div>

                {error && (
                  <div className="p-2.5 bg-red-950/40 border border-red-900/60 rounded text-xs text-red-300">
                    {error}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 max-h-[460px] overflow-y-auto pr-1">
                  {filteredOwnedGames.map((game) => {
                    const isSelected = config.gameIds.includes(game.appid);
                    return (
                      <div
                        key={game.appid}
                        onClick={() => handleToggleGame(game.appid)}
                        className={`flex flex-col p-2.5 rounded border cursor-pointer transition-all duration-200 hover:scale-[1.03] active:scale-[0.97] ${
                          isSelected
                            ? 'bg-zinc-900 border-white'
                            : 'bg-zinc-950 border-zinc-800 hover:border-zinc-650'
                        }`}
                      >
                        <img
                          src={getGameHeaderUrl(game.appid)}
                          alt={`AppID ${game.appid}`}
                          className="w-full h-20 object-cover rounded bg-zinc-900 mb-2"
                          referrerPolicy="no-referrer"
                        />
                        <div className="flex items-start justify-between gap-1 min-w-0">
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-semibold text-white truncate">
                              {game.name || `AppID ${game.appid}`}
                            </div>
                            <div className="text-[10px] text-zinc-500 font-mono">
                              AppID: {game.appid}
                            </div>
                            {typeof game.playtime_forever === 'number' && game.playtime_forever > 0 && (
                              <div className="text-[10px] text-zinc-400 mt-1 font-mono">
                                {(game.playtime_forever / 60).toFixed(1)} hrs played
                              </div>
                            )}
                          </div>
                          <div
                            className={`w-4 h-4 rounded flex items-center justify-center border shrink-0 mt-0.5 ${
                              isSelected
                                ? 'bg-white border-white text-black'
                                : 'border-zinc-700 bg-zinc-900 text-transparent'
                            }`}
                          >
                            <Check className="w-3 h-3" />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 2. Search Steam Store SubTab */}
            {activeSubTab === 'search' && (
              <div className="space-y-4">
                <form onSubmit={handleSearch} className="flex gap-2">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search any game (e.g. Counter-Strike 2, Terraria, Rust, Apex Legends)..."
                    className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3.5 py-2 text-xs text-white placeholder-zinc-500 focus:outline-hidden focus:border-white"
                  />
                  <button
                    type="submit"
                    disabled={isSearching || !searchQuery.trim()}
                    className="px-4 py-2 bg-white text-black font-bold rounded text-xs flex items-center gap-1.5 cursor-pointer disabled:opacity-50 hover:bg-zinc-200 transition-all duration-200 hover:scale-[1.02] active:scale-[0.98]"
                  >
                    {isSearching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                    <span>Search</span>
                  </button>
                </form>

                {error && (
                  <div className="p-2.5 bg-red-950/40 border border-red-900/60 rounded text-xs text-red-300">
                    {error}
                  </div>
                )}

                {searchResults.length > 0 ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 max-h-[460px] overflow-y-auto pr-1">
                    {searchResults.map((item) => {
                      const isSelected = config.gameIds.includes(item.id);
                      return (
                        <div
                          key={item.id}
                          onClick={() => handleToggleGame(item.id)}
                          className={`flex flex-col p-2.5 rounded border cursor-pointer transition-all duration-200 hover:scale-[1.03] active:scale-[0.97] ${
                            isSelected
                              ? 'bg-zinc-900 border-white'
                              : 'bg-zinc-950 border-zinc-800 hover:border-zinc-650'
                          }`}
                        >
                          <img
                            src={item.tiny_image || getGameHeaderUrl(item.id)}
                            alt={item.name}
                            className="w-full h-20 object-cover rounded bg-zinc-900 mb-2"
                            referrerPolicy="no-referrer"
                          />
                          <div className="flex items-start justify-between gap-1 min-w-0">
                            <div className="min-w-0 flex-1">
                              <div className="text-xs font-semibold text-white truncate">{item.name}</div>
                              <div className="text-[10px] text-zinc-500 font-mono">AppID: {item.id}</div>
                            </div>
                            <div
                              className={`w-4 h-4 rounded flex items-center justify-center border shrink-0 mt-0.5 ${
                                isSelected
                                  ? 'bg-white border-white text-black'
                                  : 'border-zinc-700 bg-zinc-900 text-transparent'
                              }`}
                            >
                              <Check className="w-3 h-3" />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="py-12 text-center text-xs text-zinc-500">
                    Type a title above and press Search to discover any game on Steam.
                  </div>
                )}
              </div>
            )}

            {/* 3. Manual AppIDs SubTab */}
            {activeSubTab === 'manual' && (
              <div className="space-y-4">
                <form onSubmit={handleAddCustomAppId} className="flex gap-2">
                  <input
                    type="number"
                    value={customAppIdInput}
                    onChange={(e) => setCustomAppIdInput(e.target.value)}
                    placeholder="Enter single AppID (e.g. 730 for CS2)"
                    className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3.5 py-2 text-xs text-white placeholder-zinc-500 focus:outline-hidden"
                  />
                  <button
                    type="submit"
                    className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-white rounded text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-all duration-200 hover:scale-[1.02] active:scale-[0.98]"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add AppID</span>
                  </button>
                </form>

                <div>
                  <label className="block text-xs font-medium text-zinc-400 mb-1">
                    Or paste comma-separated AppIDs
                  </label>
                  <textarea
                    rows={4}
                    value={rawAppIdList}
                    onChange={(e) => setRawAppIdList(e.target.value)}
                    placeholder="730, 440, 570, 252490, 105600..."
                    className="w-full bg-zinc-900 border border-zinc-700 rounded p-3 text-xs font-mono text-white placeholder-zinc-500 focus:outline-hidden"
                  />
                  <button
                    type="button"
                    onClick={handleApplyRawCsv}
                    className="mt-2 px-4 py-2 bg-white text-black font-bold rounded text-xs cursor-pointer hover:bg-zinc-200 transition-all duration-200 hover:scale-[1.02] active:scale-[0.98]"
                  >
                    Update List from CSV
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Selected Games Panel (4 cols on large screens) */}
        <div className="lg:col-span-4 space-y-4">
          <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-5 space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-zinc-800">
              <div>
                <h3 className="text-xs font-bold text-white uppercase tracking-wider">
                  Active Selected Games
                </h3>
                <p className="text-[11px] text-zinc-500">
                  {config.gameIds.length} of 32 max
                </p>
              </div>

              {config.gameIds.length > 0 && (
                <button
                  type="button"
                  onClick={handleClearSelected}
                  className="text-xs text-zinc-400 hover:text-red-400 flex items-center gap-1 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Clear All</span>
                </button>
              )}
            </div>

            {config.gameIds.length === 0 ? (
              <div className="py-12 text-center text-xs text-zinc-500">
                No games selected. Search or add AppIDs on the left.
              </div>
            ) : (
              <div className="space-y-2 max-h-[440px] overflow-y-auto pr-1">
                {config.gameIds.map((id) => (
                  <div
                    key={id}
                    className="flex items-center justify-between p-2 rounded bg-zinc-900 border border-zinc-800"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <img
                        src={getGameHeaderUrl(id)}
                        alt={`AppID ${id}`}
                        className="w-12 h-6 object-cover rounded shrink-0 bg-zinc-950"
                        referrerPolicy="no-referrer"
                      />
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-white truncate">
                          {getDisplayName(id)}
                        </div>
                        <div className="text-[10px] text-zinc-500 font-mono">AppID: {id}</div>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleToggleGame(id)}
                      className="p-1 text-zinc-500 hover:text-red-400 cursor-pointer"
                      title="Remove"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Apply Button in Selected Panel */}
            <div className="pt-2">
              <button
                type="button"
                onClick={handleApplyGames}
                disabled={isApplying}
                className="w-full py-2.5 bg-white hover:bg-zinc-200 text-black font-bold text-xs rounded transition-all duration-200 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 hover:scale-[1.02] active:scale-[0.98]"
              >
                {isApplying ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Check className="w-3.5 h-3.5" />
                )}
                <span>Apply Selection</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
