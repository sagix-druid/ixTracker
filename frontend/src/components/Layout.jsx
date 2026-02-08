import WalletConnect from './WalletConnect';

export default function Layout({ children }) {
  return (
    <div className="spw-min-h-screen spw-bg-sagix-bg spw-text-sagix-text spw-font-sans">
      <header className="spw-flex spw-items-center spw-justify-between spw-border-b spw-border-sagix-border spw-p-4">
        <h1 className="spw-text-xl spw-font-semibold spw-text-sagix-gold">
          Sagix Portfolio Tracker
        </h1>
        <WalletConnect />
      </header>
      <main className="spw-p-4">{children}</main>
    </div>
  );
}
