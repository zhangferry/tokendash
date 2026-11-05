import { createContext, useContext, useMemo, useEffect, type ReactNode } from 'react';
import { fetchSettings } from '../api/client.js';
import { setPricingExchangeRate } from '../../shared/modelPricing.js';
import { useLocalStorageState } from './useLocalStorageState.js';

export type Currency = 'USD' | 'CNY';

interface CurrencyContextValue {
  currency: Currency;
  setCurrency: (c: Currency) => void;
  /** 每美元对应的人民币金额。 */
  exchangeRate: number;
  setExchangeRate: (r: number) => void;
  /** 把以 USD 计的金额按当前设置格式化 */
  formatCost: (usd: number) => string;
  symbol: string;
}

const CurrencyContext = createContext<CurrencyContextValue | null>(null);

function formatCNY(cny: number): string {
  return '¥' + cny.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatUSDValue(usd: number): string {
  return '$' + usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [currency, setCurrency] = useLocalStorageState<Currency>('dashboard_currency', 'USD');
  const [exchangeRate, setExchangeRate] = useLocalStorageState<number>('dashboard_exchange_rate', 6);

  useEffect(() => {
    void fetchSettings().then(settings => { if (settings.billing) setExchangeRate(settings.billing.exchangeRate); }).catch(error => console.error('Failed to load the billing exchange rate', error));
  }, []);
  setPricingExchangeRate(exchangeRate);
  const value = useMemo<CurrencyContextValue>(() => ({
    currency,
    setCurrency,
    exchangeRate,
    setExchangeRate,
    symbol: currency === 'USD' ? '$' : '¥',
    formatCost: (usd: number) =>
      currency === 'USD' ? formatUSDValue(usd) : formatCNY(usd * exchangeRate),
  }), [currency, exchangeRate, setCurrency, setExchangeRate]);

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
}

export function useCurrency(): CurrencyContextValue {
  const ctx = useContext(CurrencyContext);
  if (!ctx) throw new Error('useCurrency must be used within CurrencyProvider');
  return ctx;
}