import { BrowserRouter, Routes, Route } from 'react-router-dom';
import CreatePoll from './pages/CreatePoll';
import Admin from './pages/Admin';
import Present from './pages/Present';
import Participate from './pages/Participate';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<CreatePoll />} />
        <Route path="/admin/:pollId" element={<Admin />} />
        <Route path="/present/:pollId" element={<Present />} />
        <Route path="/p/:pollId" element={<Participate />} />
      </Routes>
    </BrowserRouter>
  );
}
