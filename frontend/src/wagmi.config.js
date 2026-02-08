import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { mainnet, base, arbitrum, optimism } from 'viem/chains';

export const config = getDefaultConfig({
  appName: 'Sagix Portfolio Tracker',
  appDescription: 'Track your crypto portfolio across multiple chains',
  appUrl: 'https://sagix.io',
  projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID,
  chains: [mainnet, base, arbitrum, optimism],
});
