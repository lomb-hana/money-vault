// anyOf('i', /netflix/, /spotify/, ...) builds one regex matching any of the alternatives.
// Lets long keyword lists be written one alternative per line instead of a single 400-char regex.
const anyOf = (flags, ...alternatives) =>
  new RegExp(alternatives.map(re => re.source).join('|'), flags);

module.exports = { anyOf };
