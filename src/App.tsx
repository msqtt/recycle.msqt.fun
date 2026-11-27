import { useEffect } from 'react';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ToolsPage } from './features/tools/ToolsPage';
import { FlowsPage, EditorPage } from './features/editor/EditorPage';
import { RunPage, HistoryPage } from './features/run/RunPage';
import { SettingsPage } from './features/settings/SettingsPage';
import { useRunStore } from './shared/run-store';
import { seedOfficialTools } from './wtop/official';
import { seedSampleFlows } from './wtop/samples';

const NAV = [
  { to: '/flows', label: '流程' },
  { to: '/tools', label: '工具' },
  { to: '/history', label: '历史' },
  { to: '/settings', label: '设置' },
];

function RunningBanner() {
  const { runId, flowId, status, flowName } = useRunStore();
  const loc = useLocation();
  if (!runId || (status !== 'running' && status !== 'paused-human')) return null;
  if (loc.pathname === `/run/${runId}` || loc.pathname === `/flows/${flowId}`) return null;
  return (
    <NavLink
      to={`/run/${runId}`}
      className="block bg-tang border-b-2 border-ink px-4 py-1.5 text-sm font-bold text-center hover:bg-lemon"
    >
      ▶ 「{flowName}」{status === 'paused-human' ? '等待人工确认' : '运行中'} — 点击查看看板
    </NavLink>
  );
}

export function App() {
  useEffect(() => { void seedOfficialTools(); void seedSampleFlows(); }, []);
  return (
    <BrowserRouter>
      <header className="h-16 border-b-2 border-ink bg-lemon flex items-center px-4 gap-6 sticky top-0 z-[800]">
        <NavLink to="/flows" className="font-black text-xl uppercase bg-white border-2 border-ink shadow-neo-sm px-3 py-1 -rotate-1">
          ♻ 可回收
        </NavLink>
        <span className="font-mono text-xs opacity-60 hidden md:inline">recycle.msqt.fun · WTOP 编排站</span>
        <nav className="flex gap-2 ml-auto">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                `border-2 border-ink px-3 py-1 font-bold text-sm shadow-neo-sm hover:shadow-none ${isActive ? 'bg-lime' : 'bg-white'}`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <RunningBanner />
      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/flows" replace />} />
          <Route path="/flows" element={<FlowsPage />} />
          <Route path="/flows/:id" element={<EditorPage />} />
          <Route path="/tools" element={<ToolsPage />} />
          <Route path="/run/:runId" element={<RunPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/flows" replace />} />
        </Routes>
      </main>
    </BrowserRouter>
  );
}