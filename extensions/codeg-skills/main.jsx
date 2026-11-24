import React from 'react';
import { createRoot } from 'react-dom/client';
import SkillsPanel from './skills.jsx';

const forge = window.CodexForge;
const methods = { skills_list: 'list', skills_read: 'read', skills_files: 'files', skills_set: 'setEnabled' };
const api = { request: (method, args) => forge.skills.request(methods[method], args) };
createRoot(document.getElementById('root')).render(<SkillsPanel api={api} onClose={() => forge.panels.close('main')}/>);
