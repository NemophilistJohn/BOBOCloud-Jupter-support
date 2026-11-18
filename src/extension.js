const id = 'bobocloud.notebook-preview';

export async function activate(context) {
  const { i18n, subscriptions } = context;
  const [major, minor] = context.apiVersion.split('.').map(Number);
  const notebookIcon = major > 1 || (major === 1 && minor >= 7);
  subscriptions.add(await context.documentViews.register({
    id: id + '.jupyter',
    title: i18n.t('preview')
  }));
  const sidebar = await context.sourceControl.register({
    id: id + '.sidebar',
    title: i18n.t('notebook'),
    ...(notebookIcon ? { icon: 'notebook' } : {}),
    order: 30
  });
  subscriptions.add(sidebar);
  const publish = () => sidebar.setState({
    phase: 'ready',
    title: i18n.t('notebook'),
    summary: {
      items: [
        { label: i18n.t('format'), value: '.ipynb' }
      ]
    }
  });
  await publish();
  subscriptions.add(i18n.onDidChange(() => { void publish().catch(() => {}); }));
}
