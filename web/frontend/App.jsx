import { BrowserRouter } from "react-router-dom";
import Routes from "./Routes";

import { QueryProvider, PolarisProvider } from "./components";

// App Bridge 4 initialises itself from the app-bridge.js script tag in index.html and exposes
// the global `shopify` object, so there is no Provider to mount. The previous AppBridgeProvider
// wrapper belonged to the legacy @shopify/app-bridge v3 packages and has been removed.
export default function App() {
  const pages = import.meta.globEager("./pages/**/!(*.test.[jt]sx)*.([jt]sx)");

  return (
    <PolarisProvider>
      <BrowserRouter>
        <QueryProvider>
          <Routes pages={pages} />
        </QueryProvider>
      </BrowserRouter>
    </PolarisProvider>
  );
}
