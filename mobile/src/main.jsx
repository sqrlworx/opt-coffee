import { AppRegistry } from 'react-native';
import App from './App.jsx';

AppRegistry.registerComponent('forum', () => App);
AppRegistry.runApplication('forum', { rootTag: document.getElementById('root') });
