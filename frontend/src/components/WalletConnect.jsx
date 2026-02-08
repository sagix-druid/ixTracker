import { ConnectButton } from '@rainbow-me/rainbowkit';

export default function WalletConnect() {
  return (
    <ConnectButton
      accountStatus={{ largeScreen: 'full', smallScreen: 'avatar' }}
      chainStatus={{ largeScreen: 'icon', smallScreen: 'icon' }}
      showBalance={{ largeScreen: true, smallScreen: false }}
    />
  );
}
