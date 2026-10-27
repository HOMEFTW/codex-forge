// Class-name composition used by the vendored DSH UI primitives.
export default function classNames(...values) {
  const names=[];
  function add(value) {
    if (!value) return;
    if (typeof value==='string'||typeof value==='number') names.push(String(value));
    else if (Array.isArray(value)) value.forEach(add);
    else if (typeof value==='object') for (const key of Object.keys(value)) if (value[key]) names.push(key);
  }
  values.forEach(add);
  return names.join(' ');
}
