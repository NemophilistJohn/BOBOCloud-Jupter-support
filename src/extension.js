const id = 'bobocloud.notebook-preview';

export async function activate(context) {
  const { i18n, subscriptions } = context;
  subscriptions.add(await context.documentViews.register({
    id: id + '.jupyter',
    title: i18n.t('preview')
  }));
  const sidebar = await context.sourceControl.register({
    id: id + '.sidebar',
    title: i18n.t('notebook'),
    icon: 'git-branch',
    order: 30
  });
  subscriptions.add(sidebar);
  const publish = () => sidebar.setState({
    phase: 'ready',
    title: i18n.t('notebook'),
    summary: {
      items: [
        { label: i18n.t('format'), value: '.ipynb' },
        { label: i18n.t('mode'), value: i18n.t('readOnly') }
      ]
    }
  });
  await publish();
  subscriptions.add(i18n.onDidChange(() => { void publish().catch(() => {}); }));
}
