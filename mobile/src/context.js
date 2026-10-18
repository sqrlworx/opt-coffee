import { createContext, useContext } from 'react';

// Who's logged in, what the server can do, and the app's toasts. See App.jsx.
export const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);
