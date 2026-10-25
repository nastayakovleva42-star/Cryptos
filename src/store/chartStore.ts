import { create } from 'zustand';

interface ChartState {
  symbol: string;
  interval: string;
  setSymbol: (symbol: string) => void;
  setInterval: (interval: string) => void;
  loadState: () => void;
}

export const useChartStore = create<ChartState>((set) => ({
  symbol: 'BTCUSDT',
  interval: '1h',
  setSymbol: (symbol) => set({ symbol }),
  setInterval: (interval) => set({ interval }),
  loadState: () => {
    const savedSymbol = localStorage.getItem('chartSymbol');
    const savedInterval = localStorage.getItem('chartInterval');
    if (savedSymbol) set({ symbol: savedSymbol });
    if (savedInterval) set({ interval: savedInterval });
  },
}));
