export function resultBarTransitions(previousResults, currentResults) {
  const previousById = previousResults?.id === currentResults.id
    ? new Map(previousResults.options.map((option) => [option.id, option.percentage]))
    : new Map();

  return new Map(currentResults.options.map((option) => {
    const previousPercentage = previousById.get(option.id);
    return [option.id, {
      animate: previousPercentage === undefined || previousPercentage !== option.percentage,
      startPercentage: previousPercentage ?? 0,
    }];
  }));
}
